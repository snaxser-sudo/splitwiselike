import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CONFIG_STORAGE_KEY = "splitfair.supabase.config";
const SELECTED_GROUP_KEY = "splitfair.selectedGroupId";
const app = document.querySelector("#app");

let supabase = null;
let authSubscription = null;

const state = {
  config: null,
  session: null,
  profile: null,
  groups: [],
  selectedGroupId: null,
  members: [],
  expenses: [],
  splitsByExpense: new Map(),
  settlements: [],
  notice: "",
  error: "",
};

init().catch((error) => {
  app.innerHTML = `
    <main class="screen setup-screen">
      <section class="form-panel">
        <h2>Туту-сплит</h2>
        <div class="error">${escapeHtml(readableError(error))}</div>
      </section>
    </main>
  `;
});

async function init() {
  state.config = readConfig();

  if (!hasConfig(state.config)) {
    renderSetup();
    return;
  }

  await initializeSupabase();
}

async function initializeSupabase() {
  if (authSubscription) {
    authSubscription.unsubscribe();
  }

  supabase = createClient(
    state.config.supabaseUrl,
    state.config.supabasePublishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    },
  );

  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error) throw error;

  state.session = session;

  const { data } = supabase.auth.onAuthStateChange(async (_event, session) => {
    state.session = session;
    state.notice = "";
    state.error = "";

    if (session) {
      await bootAuthenticated();
    } else {
      clearWorkspace();
      renderAuth();
    }
  });

  authSubscription = data.subscription;

  if (state.session) {
    await bootAuthenticated();
  } else {
    renderAuth();
  }
}

async function bootAuthenticated() {
  try {
    await ensureProfile();
    const joinedGroupId = await consumeInviteFromUrl();
    await loadWorkspace(joinedGroupId);
    renderApp();
  } catch (error) {
    state.error = readableError(error);
    await loadWorkspace();
    renderApp();
  }
}

function readConfig() {
  const fileConfig = window.SPLITFAIR_CONFIG || {};
  const saved = safeJson(localStorage.getItem(CONFIG_STORAGE_KEY)) || {};

  return {
    supabaseUrl: normalizeText(fileConfig.supabaseUrl || saved.supabaseUrl),
    supabasePublishableKey: normalizeText(
      fileConfig.supabasePublishableKey || saved.supabasePublishableKey,
    ),
  };
}

function hasConfig(config) {
  return Boolean(config?.supabaseUrl && config?.supabasePublishableKey);
}

function clearWorkspace() {
  state.profile = null;
  state.groups = [];
  state.selectedGroupId = null;
  state.members = [];
  state.expenses = [];
  state.splitsByExpense = new Map();
  state.settlements = [];
}

async function ensureProfile() {
  const user = state.session?.user;
  if (!user) return;

  const { data, error } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    const displayName =
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      user.email?.split("@")[0] ||
      "New user";

    const { data: inserted, error: insertError } = await supabase
      .from("profiles")
      .insert({ id: user.id, display_name: displayName })
      .select("id, display_name, avatar_url")
      .single();

    if (insertError) throw insertError;
    state.profile = inserted;
    return;
  }

  state.profile = data;
}

async function consumeInviteFromUrl() {
  const url = new URL(window.location.href);
  const inviteCode = url.searchParams.get("join");

  if (!inviteCode || !state.session) return null;

  const { data, error } = await supabase.rpc("join_group_by_invite", {
    p_invite_code: inviteCode,
  });

  if (error) throw error;

  url.searchParams.delete("join");
  window.history.replaceState({}, document.title, url.toString());
  state.notice = "Invite accepted.";
  return data;
}

async function loadWorkspace(preferredGroupId) {
  const { data, error } = await supabase
    .from("groups")
    .select("id, name, currency, invite_code, created_by, created_at")
    .order("created_at", { ascending: false });

  if (error) throw error;

  state.groups = data || [];

  const storedGroupId = localStorage.getItem(SELECTED_GROUP_KEY);
  const nextGroupId =
    preferredGroupId ||
    (state.groups.some((group) => group.id === storedGroupId)
      ? storedGroupId
      : null) ||
    state.selectedGroupId ||
    state.groups[0]?.id ||
    null;

  state.selectedGroupId = state.groups.some((group) => group.id === nextGroupId)
    ? nextGroupId
    : null;

  if (state.selectedGroupId) {
    localStorage.setItem(SELECTED_GROUP_KEY, state.selectedGroupId);
    await loadGroupDetails(state.selectedGroupId);
  } else {
    state.members = [];
    state.expenses = [];
    state.splitsByExpense = new Map();
    state.settlements = [];
  }
}

async function loadGroupDetails(groupId) {
  const [membersResult, expensesResult, settlementsResult] = await Promise.all([
    supabase
      .from("group_members")
      .select("group_id, user_id, role, joined_at")
      .eq("group_id", groupId)
      .order("joined_at", { ascending: true }),
    supabase
      .from("expenses")
      .select(
        "id, group_id, title, amount_cents, currency, paid_by, spent_at, notes, created_by, created_at",
      )
      .eq("group_id", groupId)
      .order("spent_at", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("settlements")
      .select(
        "id, group_id, from_user, to_user, amount_cents, currency, settled_at, created_by, created_at",
      )
      .eq("group_id", groupId)
      .order("settled_at", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);

  if (membersResult.error) throw membersResult.error;
  if (expensesResult.error) throw expensesResult.error;
  if (settlementsResult.error) throw settlementsResult.error;

  const members = membersResult.data || [];
  const userIds = [...new Set(members.map((member) => member.user_id))];
  const expenseIds = (expensesResult.data || []).map((expense) => expense.id);

  const [profilesResult, splitsResult] = await Promise.all([
    userIds.length
      ? supabase
          .from("profiles")
          .select("id, display_name, avatar_url")
          .in("id", userIds)
      : Promise.resolve({ data: [], error: null }),
    expenseIds.length
      ? supabase
          .from("expense_splits")
          .select("expense_id, user_id, share_cents")
          .in("expense_id", expenseIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (profilesResult.error) throw profilesResult.error;
  if (splitsResult.error) throw splitsResult.error;

  const profilesById = new Map(
    (profilesResult.data || []).map((profile) => [profile.id, profile]),
  );

  state.members = members.map((member) => ({
    ...member,
    profile: profilesById.get(member.user_id) || null,
  }));

  state.expenses = expensesResult.data || [];
  state.settlements = settlementsResult.data || [];
  state.splitsByExpense = groupByExpense(splitsResult.data || []);
}

function groupByExpense(splits) {
  const grouped = new Map();

  for (const split of splits) {
    const bucket = grouped.get(split.expense_id) || [];
    bucket.push(split);
    grouped.set(split.expense_id, bucket);
  }

  return grouped;
}

function renderSetup() {
  app.innerHTML = `
    <main class="screen setup-screen">
      <section class="setup-grid">
        ${renderBrandPanel()}
        <form id="config-form" class="form-panel">
          <div class="panel-header">
            <div>
              <h2>Supabase</h2>
              <p>URL and publishable key</p>
            </div>
            ${icon("settings")}
          </div>
          <div class="field">
            <label for="supabase-url">Project URL</label>
            <input id="supabase-url" name="supabaseUrl" type="url" placeholder="https://..." required />
          </div>
          <div class="field">
            <label for="supabase-key">Publishable key</label>
            <input id="supabase-key" name="supabasePublishableKey" type="password" autocomplete="off" required />
          </div>
          <button class="button primary" type="submit">${icon("check")}Connect</button>
          ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ""}
        </form>
      </section>
    </main>
  `;

  document.querySelector("#config-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.config = {
      supabaseUrl: normalizeText(form.get("supabaseUrl")),
      supabasePublishableKey: normalizeText(form.get("supabasePublishableKey")),
    };

    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(state.config));
    state.error = "";
    await initializeSupabase();
  });
}

function renderAuth() {
  const joinCode = new URL(window.location.href).searchParams.get("join");

  app.innerHTML = `
    <main class="screen auth-screen travel-auth-screen">
      <section class="tutu-hero">
        <div class="tutu-hero-top">
          <div class="brand-mark tutu-brand">
            <span class="mark">ТС</span>
            <span>Туту-сплит</span>
          </div>
          <button class="button google-button" type="button" data-action="google-sign-in">${icon("log-in")}Войти через Google</button>
        </div>
        <div class="tutu-hero-copy">
          <h1>Едете куда-то вместе с друзьями?</h1>
          <p>Мы сделаем расчёты между вами в разы проще: добавляйте траты, делите расходы и сразу видьте, кто кому должен.</p>
          ${joinCode ? `<span class="invite-note">После входа откроем приглашение в группу.</span>` : ""}
        </div>
        <div class="travel-card-grid" aria-hidden="true">
          <article class="travel-card">
            ${icon("plane")}
            <strong>Билеты</strong>
            <span>самолеты, поезда, автобусы</span>
          </article>
          <article class="travel-card">
            ${icon("bed")}
            <strong>Жилье</strong>
            <span>отели, квартиры, хостелы</span>
          </article>
          <article class="travel-card">
            ${icon("utensils")}
            <strong>Еда</strong>
            <span>кафе, продукты, ужины</span>
          </article>
          <article class="travel-card">
            ${icon("car")}
            <strong>Транспорт</strong>
            <span>такси, аренда, бензин</span>
          </article>
        </div>
        <div class="split-search-bar">
          <span>Кто платил?</span>
          <span>За что?</span>
          <span>Сколько?</span>
          <button class="button google-button" type="button" data-action="google-sign-in">${icon("log-in")}Начать</button>
        </div>
        <div class="auth-feedback">
          ${state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : ""}
          ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ""}
        </div>
      </section>
    </main>
  `;

  document.querySelectorAll("[data-action='google-sign-in']").forEach((button) => {
    button.addEventListener("click", handleGoogleSignIn);
  });
}

function renderBrandPanel() {
  return `
    <section class="brand-panel">
      <div>
        <div class="brand-mark">
          <span class="mark">ТС</span>
          <span>Туту-сплит</span>
        </div>
        <div class="brand-copy">
          <h1>Туту-сплит</h1>
          <p>Едете куда-то вместе с друзьями? Мы сделаем расчёты между вами в разы проще.</p>
        </div>
      </div>
      <div class="brand-stats">
        <div><strong>3</strong><span>шага до понятных долгов</span></div>
        <div><strong>1</strong><span>ссылка для всей группы</span></div>
        <div><strong>0</strong><span>ручных таблиц</span></div>
      </div>
    </section>
  `;
}

async function handleGoogleSignIn() {
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: getCurrentPageUrl(),
      },
    });

    if (error) throw error;
  } catch (error) {
    state.error = readableError(error);
    state.notice = "";
    renderAuth();
  }
}

function renderApp() {
  const selectedGroup = getSelectedGroup();

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand-mark">
            <span class="mark">ТС</span>
            <span>Туту-сплит</span>
          </div>
          <nav class="group-tabs" aria-label="Groups">
            ${state.groups.map(renderGroupTab).join("")}
          </nav>
          <div class="account-menu">
            <span class="avatar" title="${escapeAttribute(state.profile?.display_name || "Account")}">${escapeHtml(initials(state.profile?.display_name || state.session?.user?.email || "U"))}</span>
            <button class="icon-button" data-action="sign-out" title="Sign out" aria-label="Sign out">${icon("log-out")}</button>
          </div>
        </div>
      </header>
      <main class="workspace">
        <aside class="sidebar">
          ${renderGroupsPanel()}
          ${renderProfilePanel()}
        </aside>
        ${selectedGroup ? renderGroupWorkspace(selectedGroup) : renderEmptyWorkspace()}
      </main>
    </div>
  `;

  bindAppEvents();
}

function renderGroupTab(group) {
  const active = group.id === state.selectedGroupId ? "active" : "";
  return `
    <button class="tab ${active}" type="button" data-action="select-group" data-group-id="${escapeAttribute(group.id)}">
      ${escapeHtml(group.name)}
    </button>
  `;
}

function renderGroupsPanel() {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Groups</h2>
          <p>${state.groups.length} active</p>
        </div>
        ${icon("users")}
      </div>
      <div class="group-list">
        ${state.groups.map(renderGroupListItem).join("") || `<div class="muted">No groups yet.</div>`}
      </div>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>New group</h2>
          <p>Shared currency</p>
        </div>
        ${icon("plus")}
      </div>
      <form id="group-form">
        <div class="field">
          <label for="group-name">Name</label>
          <input id="group-name" name="name" placeholder="Lisbon trip" required maxlength="80" />
        </div>
        <div class="field">
          <label for="group-currency">Currency</label>
          <select id="group-currency" name="currency">
            ${["USD", "EUR", "GBP", "PLN", "UAH", "RUB", "GEL", "TRY"].map((currency) => `<option value="${currency}">${currency}</option>`).join("")}
          </select>
        </div>
        <button class="button primary" type="submit">${icon("plus")}Create</button>
      </form>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Join</h2>
          <p>Invite code</p>
        </div>
        ${icon("link")}
      </div>
      <form id="join-form">
        <div class="field">
          <label for="invite-code">Code</label>
          <input id="invite-code" name="inviteCode" autocomplete="off" required />
        </div>
        <button class="button secondary" type="submit">${icon("log-in")}Join</button>
      </form>
    </section>
  `;
}

function renderGroupListItem(group) {
  const active = group.id === state.selectedGroupId ? "active" : "";

  return `
    <button class="${active}" type="button" data-action="select-group" data-group-id="${escapeAttribute(group.id)}">
      <span>
        <strong>${escapeHtml(group.name)}</strong>
        <span>${escapeHtml(group.currency)}</span>
      </span>
      ${icon("chevron-right")}
    </button>
  `;
}

function renderProfilePanel() {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Profile</h2>
          <p>${escapeHtml(state.session?.user?.email || "")}</p>
        </div>
        ${icon("user")}
      </div>
      <form id="profile-form">
        <div class="field">
          <label for="display-name">Display name</label>
          <input id="display-name" name="displayName" value="${escapeAttribute(state.profile?.display_name || "")}" required maxlength="80" />
        </div>
        <button class="button secondary" type="submit">${icon("check")}Save</button>
      </form>
    </section>
  `;
}

function renderEmptyWorkspace() {
  return `
    <section class="empty-state">
      <div>
        <h2>No group selected</h2>
        <p>Create a group or join one with an invite code.</p>
      </div>
    </section>
  `;
}

function renderGroupWorkspace(group) {
  const stats = calculateStats(group);

  return `
    <section class="main-grid">
      <div class="content-column">
        ${renderFeedback()}
        ${renderGroupHero(group)}
        ${renderSummary(group, stats)}
        ${renderMembers()}
        ${renderDebts(group, stats.debts)}
        ${renderExpenses(group)}
      </div>
      <div class="action-column">
        ${renderExpenseForm(group)}
        ${renderSettlementForm(group)}
        ${renderSettlements(group)}
      </div>
    </section>
  `;
}

function renderFeedback() {
  if (!state.notice && !state.error) return "";

  return `
    <div>
      ${state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : ""}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ""}
    </div>
  `;
}

function renderGroupHero(group) {
  const inviteUrl = getInviteUrl(group.invite_code);

  return `
    <section class="group-hero">
      <div class="hero-row">
        <div>
          <h1>${escapeHtml(group.name)}</h1>
          <p class="muted">${escapeHtml(group.currency)} - ${state.members.length} members</p>
        </div>
        <div class="invite-box">
          <span class="code" title="${escapeAttribute(inviteUrl)}">${escapeHtml(group.invite_code)}</span>
          <button class="icon-button" type="button" data-action="copy-invite" data-invite-url="${escapeAttribute(inviteUrl)}" title="Copy invite" aria-label="Copy invite">${icon("copy")}</button>
        </div>
      </div>
    </section>
  `;
}

function renderSummary(group, stats) {
  const balance = stats.userBalance;
  const balanceClass = balance > 0 ? "positive" : balance < 0 ? "negative" : "neutral";
  const balanceLabel =
    balance > 0 ? "You are owed" : balance < 0 ? "You owe" : "You are settled";

  return `
    <section class="summary-grid">
      <div class="summary-tile neutral">
        <span>Total spent</span>
        <strong>${formatMoney(stats.totalSpent, group.currency)}</strong>
      </div>
      <div class="summary-tile ${balanceClass}">
        <span>${balanceLabel}</span>
        <strong>${formatMoney(Math.abs(balance), group.currency)}</strong>
      </div>
      <div class="summary-tile neutral">
        <span>Open transfers</span>
        <strong>${stats.debts.length}</strong>
      </div>
    </section>
  `;
}

function renderMembers() {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Members</h2>
          <p>${state.members.length} people</p>
        </div>
        ${icon("users")}
      </div>
      <div class="member-grid">
        ${state.members.map(renderMemberPill).join("")}
      </div>
    </section>
  `;
}

function renderMemberPill(member) {
  const name = memberName(member.user_id);
  return `
    <span class="member-pill">
      <span class="mini-avatar">${escapeHtml(initials(name))}</span>
      <span>${escapeHtml(name)}</span>
      ${member.role === "owner" ? `<span class="chip">owner</span>` : ""}
    </span>
  `;
}

function renderDebts(group, debts) {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Settle up</h2>
          <p>${debts.length ? "Simplified balances" : "Everything is even"}</p>
        </div>
        ${icon("wallet")}
      </div>
      <div class="debt-list">
        ${
          debts
            .map(
              (debt) => `
                <div class="debt-item">
                  <div class="debt-line">
                    <strong>${escapeHtml(memberName(debt.from))}</strong>
                    <span>pays</span>
                    <strong>${escapeHtml(memberName(debt.to))}</strong>
                    <span class="amount">${formatMoney(debt.amount, group.currency)}</span>
                  </div>
                  <button class="button secondary" type="button" data-action="prefill-settlement" data-from="${escapeAttribute(debt.from)}" data-to="${escapeAttribute(debt.to)}" data-amount="${debt.amount}">
                    ${icon("check")}Settle
                  </button>
                </div>
              `,
            )
            .join("") ||
          `<div class="empty-state"><div><h3>Settled</h3><p>No transfers needed right now.</p></div></div>`
        }
      </div>
    </section>
  `;
}

function renderExpenses(group) {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Expenses</h2>
          <p>${state.expenses.length} records</p>
        </div>
        ${icon("receipt")}
      </div>
      <div class="expense-list">
        ${state.expenses.map((expense) => renderExpenseItem(expense, group)).join("") || `<div class="empty-state"><div><h3>No expenses</h3><p>Add the first shared cost.</p></div></div>`}
      </div>
    </section>
  `;
}

function renderExpenseItem(expense, group) {
  const splits = state.splitsByExpense.get(expense.id) || [];

  return `
    <article class="expense-item">
      <div class="expense-head">
        <div class="expense-title">
          <strong>${escapeHtml(expense.title)}</strong>
          <span>Paid by ${escapeHtml(memberName(expense.paid_by))} - ${formatDate(expense.spent_at)}</span>
        </div>
        <div class="toolbar">
          <strong>${formatMoney(expense.amount_cents, expense.currency || group.currency)}</strong>
          <button class="icon-button danger" type="button" data-action="delete-expense" data-expense-id="${escapeAttribute(expense.id)}" title="Delete expense" aria-label="Delete expense">${icon("trash")}</button>
        </div>
      </div>
      <div class="split-chips">
        ${splits.map((split) => `<span class="chip">${escapeHtml(memberName(split.user_id))}: ${formatMoney(split.share_cents, group.currency)}</span>`).join("")}
      </div>
    </article>
  `;
}

function renderExpenseForm(group) {
  const today = todayISO();

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>New expense</h2>
          <p>${escapeHtml(group.currency)}</p>
        </div>
        ${icon("plus")}
      </div>
      <form id="expense-form">
        <div class="field">
          <label for="expense-title">Title</label>
          <input id="expense-title" name="title" placeholder="Dinner" required maxlength="140" />
        </div>
        <div class="two-fields">
          <div class="field">
            <label for="expense-amount">Amount</label>
            <input id="expense-amount" name="amount" inputmode="decimal" placeholder="42.50" required />
          </div>
          <div class="field">
            <label for="expense-date">Date</label>
            <input id="expense-date" name="spentAt" type="date" value="${today}" required />
          </div>
        </div>
        <div class="field">
          <label for="expense-paid-by">Paid by</label>
          <select id="expense-paid-by" name="paidBy" required>
            ${state.members.map((member) => `<option value="${escapeAttribute(member.user_id)}">${escapeHtml(memberName(member.user_id))}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <span class="field-label">Split</span>
          <div class="segmented">
            <input id="split-equal" type="radio" name="splitMode" value="equal" checked />
            <label for="split-equal">Equal</label>
            <input id="split-manual" type="radio" name="splitMode" value="manual" />
            <label for="split-manual">Manual</label>
          </div>
        </div>
        <div id="split-editor" class="split-editor"></div>
        <div id="split-preview" class="split-preview"></div>
        <div class="field">
          <label for="expense-notes">Notes</label>
          <textarea id="expense-notes" name="notes"></textarea>
        </div>
        <button class="button primary" type="submit">${icon("check")}Save expense</button>
      </form>
    </section>
  `;
}

function renderSettlementForm(group) {
  return `
    <section class="panel" id="settlement-panel">
      <div class="panel-header">
        <div>
          <h2>Record payment</h2>
          <p>${escapeHtml(group.currency)}</p>
        </div>
        ${icon("wallet")}
      </div>
      <form id="settlement-form">
        <div class="two-fields">
          <div class="field">
            <label for="settlement-from">From</label>
            <select id="settlement-from" name="fromUser" required>
              ${state.members.map((member) => `<option value="${escapeAttribute(member.user_id)}">${escapeHtml(memberName(member.user_id))}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="settlement-to">To</label>
            <select id="settlement-to" name="toUser" required>
              ${state.members.map((member) => `<option value="${escapeAttribute(member.user_id)}">${escapeHtml(memberName(member.user_id))}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="two-fields">
          <div class="field">
            <label for="settlement-amount">Amount</label>
            <input id="settlement-amount" name="amount" inputmode="decimal" required />
          </div>
          <div class="field">
            <label for="settlement-date">Date</label>
            <input id="settlement-date" name="settledAt" type="date" value="${todayISO()}" required />
          </div>
        </div>
        <button class="button secondary" type="submit">${icon("check")}Record</button>
      </form>
    </section>
  `;
}

function renderSettlements(group) {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Payments</h2>
          <p>${state.settlements.length} records</p>
        </div>
        ${icon("receipt")}
      </div>
      <div class="settlement-list">
        ${
          state.settlements
            .map(
              (settlement) => `
                <div class="settlement-row">
                  <span>${escapeHtml(memberName(settlement.from_user))} paid ${escapeHtml(memberName(settlement.to_user))}</span>
                  <div class="toolbar">
                    <strong>${formatMoney(settlement.amount_cents, settlement.currency || group.currency)}</strong>
                    <button class="icon-button danger" type="button" data-action="delete-settlement" data-settlement-id="${escapeAttribute(settlement.id)}" title="Delete payment" aria-label="Delete payment">${icon("trash")}</button>
                  </div>
                </div>
              `,
            )
            .join("") || `<div class="muted">No payments recorded.</div>`
        }
      </div>
    </section>
  `;
}

function bindAppEvents() {
  document
    .querySelector("[data-action='sign-out']")
    ?.addEventListener("click", async () => {
      await supabase.auth.signOut();
    });

  document.querySelectorAll("[data-action='select-group']").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedGroupId = button.dataset.groupId;
      state.notice = "";
      state.error = "";
      await loadWorkspace(state.selectedGroupId);
      renderApp();
    });
  });

  document
    .querySelector("[data-action='copy-invite']")
    ?.addEventListener("click", handleCopyInvite);

  document.querySelectorAll("[data-action='prefill-settlement']").forEach((button) => {
    button.addEventListener("click", () => prefillSettlement(button.dataset));
  });

  document.querySelectorAll("[data-action='delete-expense']").forEach((button) => {
    button.addEventListener("click", () => deleteExpense(button.dataset.expenseId));
  });

  document.querySelectorAll("[data-action='delete-settlement']").forEach((button) => {
    button.addEventListener("click", () => deleteSettlement(button.dataset.settlementId));
  });

  document.querySelector("#group-form")?.addEventListener("submit", handleCreateGroup);
  document.querySelector("#join-form")?.addEventListener("submit", handleJoinGroup);
  document.querySelector("#profile-form")?.addEventListener("submit", handleProfileSave);
  document.querySelector("#expense-form")?.addEventListener("submit", handleCreateExpense);
  document
    .querySelector("#settlement-form")
    ?.addEventListener("submit", handleCreateSettlement);

  bindSplitEditor();
}

async function handleCreateGroup(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const name = normalizeText(form.get("name"));
  const currency = normalizeText(form.get("currency")).toUpperCase();

  try {
    const { data, error } = await supabase
      .from("groups")
      .insert({ name, currency, created_by: state.session.user.id })
      .select("id")
      .single();

    if (error) throw error;

    state.notice = "Group created.";
    state.error = "";
    await loadWorkspace(data.id);
    renderApp();
  } catch (error) {
    showAppError(error);
  }
}

async function handleJoinGroup(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const inviteCode = normalizeText(form.get("inviteCode"));

  try {
    const { data, error } = await supabase.rpc("join_group_by_invite", {
      p_invite_code: inviteCode,
    });

    if (error) throw error;

    state.notice = "Group joined.";
    state.error = "";
    await loadWorkspace(data);
    renderApp();
  } catch (error) {
    showAppError(error);
  }
}

async function handleProfileSave(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const displayName = normalizeText(form.get("displayName"));

  try {
    const { data, error } = await supabase
      .from("profiles")
      .update({ display_name: displayName })
      .eq("id", state.session.user.id)
      .select("id, display_name, avatar_url")
      .single();

    if (error) throw error;

    state.profile = data;
    state.notice = "Profile saved.";
    state.error = "";
    await loadWorkspace(state.selectedGroupId);
    renderApp();
  } catch (error) {
    showAppError(error);
  }
}

async function handleCreateExpense(event) {
  event.preventDefault();
  const group = getSelectedGroup();
  const form = new FormData(event.currentTarget);

  try {
    const amountCents = parseMoneyToCents(form.get("amount"));
    if (amountCents <= 0) throw new Error("Amount must be greater than zero.");

    const splits = readSplitsFromForm(amountCents);
    const splitTotal = splits.reduce((sum, split) => sum + split.share_cents, 0);

    if (!splits.length) throw new Error("Choose at least one participant.");
    if (splitTotal !== amountCents) {
      throw new Error("Split total must match the expense amount.");
    }

    const { error } = await supabase.rpc("create_expense", {
      p_group_id: group.id,
      p_title: normalizeText(form.get("title")),
      p_amount_cents: amountCents,
      p_currency: group.currency,
      p_paid_by: normalizeText(form.get("paidBy")),
      p_spent_at: normalizeText(form.get("spentAt")),
      p_notes: normalizeText(form.get("notes")) || null,
      p_splits: splits,
    });

    if (error) throw error;

    state.notice = "Expense saved.";
    state.error = "";
    await loadWorkspace(group.id);
    renderApp();
  } catch (error) {
    showAppError(error);
  }
}

async function handleCreateSettlement(event) {
  event.preventDefault();
  const group = getSelectedGroup();
  const form = new FormData(event.currentTarget);

  try {
    const amountCents = parseMoneyToCents(form.get("amount"));

    if (amountCents <= 0) throw new Error("Amount must be greater than zero.");

    const { error } = await supabase.rpc("create_settlement", {
      p_group_id: group.id,
      p_from_user: normalizeText(form.get("fromUser")),
      p_to_user: normalizeText(form.get("toUser")),
      p_amount_cents: amountCents,
      p_currency: group.currency,
      p_settled_at: normalizeText(form.get("settledAt")),
    });

    if (error) throw error;

    state.notice = "Payment recorded.";
    state.error = "";
    await loadWorkspace(group.id);
    renderApp();
  } catch (error) {
    showAppError(error);
  }
}

async function deleteExpense(expenseId) {
  if (!window.confirm("Delete this expense?")) return;

  try {
    const { error } = await supabase.from("expenses").delete().eq("id", expenseId);
    if (error) throw error;

    state.notice = "Expense deleted.";
    state.error = "";
    await loadWorkspace(state.selectedGroupId);
    renderApp();
  } catch (error) {
    showAppError(error);
  }
}

async function deleteSettlement(settlementId) {
  if (!window.confirm("Delete this payment?")) return;

  try {
    const { error } = await supabase
      .from("settlements")
      .delete()
      .eq("id", settlementId);

    if (error) throw error;

    state.notice = "Payment deleted.";
    state.error = "";
    await loadWorkspace(state.selectedGroupId);
    renderApp();
  } catch (error) {
    showAppError(error);
  }
}

function bindSplitEditor() {
  const form = document.querySelector("#expense-form");
  const editor = document.querySelector("#split-editor");
  const amountInput = document.querySelector("#expense-amount");

  if (!form || !editor || !amountInput) return;

  const paint = () => {
    const mode = form.elements.splitMode.value;
    const checked = new Set(
      [...editor.querySelectorAll(".split-participant:checked")].map(
        (input) => input.value,
      ),
    );
    const manualValues = new Map(
      [...editor.querySelectorAll(".manual-share")].map((input) => [
        input.dataset.userId,
        input.value,
      ]),
    );

    if (!checked.size && editor.dataset.mode !== "equal") {
      state.members.forEach((member) => checked.add(member.user_id));
    }

    editor.dataset.mode = mode;
    editor.innerHTML =
      mode === "manual"
        ? renderManualSplitRows(manualValues)
        : renderEqualSplitRows(checked);

    editor
      .querySelectorAll("input")
      .forEach((input) => input.addEventListener("input", updateSplitPreview));
    editor
      .querySelectorAll("input")
      .forEach((input) => input.addEventListener("change", updateSplitPreview));

    updateSplitPreview();
  };

  form.querySelectorAll("input[name='splitMode']").forEach((radio) => {
    radio.addEventListener("change", paint);
  });

  amountInput.addEventListener("input", () => {
    if (form.elements.splitMode.value === "equal") {
      paint();
    } else {
      updateSplitPreview();
    }
  });

  paint();
}

function renderEqualSplitRows(checked) {
  return state.members
    .map((member) => {
      const isChecked = checked.size ? checked.has(member.user_id) : true;
      return `
        <div class="split-row">
          <label>
            <input class="split-participant" type="checkbox" value="${escapeAttribute(member.user_id)}" ${isChecked ? "checked" : ""} />
            <span>${escapeHtml(memberName(member.user_id))}</span>
          </label>
          <span class="muted equal-share" data-user-id="${escapeAttribute(member.user_id)}"></span>
        </div>
      `;
    })
    .join("");
}

function renderManualSplitRows(values) {
  return state.members
    .map(
      (member) => `
        <div class="split-row">
          <span>${escapeHtml(memberName(member.user_id))}</span>
          <input class="manual-share" data-user-id="${escapeAttribute(member.user_id)}" type="text" inputmode="decimal" value="${escapeAttribute(values.get(member.user_id) || "")}" />
        </div>
      `,
    )
    .join("");
}

function updateSplitPreview() {
  const form = document.querySelector("#expense-form");
  const preview = document.querySelector("#split-preview");

  if (!form || !preview) return;

  let amountCents = 0;

  try {
    amountCents = parseMoneyToCents(form.elements.amount.value);
  } catch {
    amountCents = 0;
  }

  if (form.elements.splitMode.value === "equal") {
    const selected = [
      ...document.querySelectorAll(".split-participant:checked"),
    ].map((input) => input.value);
    const shares = splitEqually(amountCents, selected);

    document.querySelectorAll(".equal-share").forEach((node) => {
      const share = shares.find((item) => item.user_id === node.dataset.userId);
      node.textContent = share
        ? formatMoney(share.share_cents, getSelectedGroup()?.currency || "USD")
        : formatMoney(0, getSelectedGroup()?.currency || "USD");
    });

    preview.textContent = selected.length
      ? `${selected.length} participants`
      : "No participants selected";
    return;
  }

  const manualTotal = [...document.querySelectorAll(".manual-share")].reduce(
    (sum, input) => {
      try {
        return sum + parseMoneyToCents(input.value);
      } catch {
        return sum;
      }
    },
    0,
  );

  preview.textContent = `Manual total: ${formatMoney(manualTotal, getSelectedGroup()?.currency || "USD")}`;
}

function readSplitsFromForm(amountCents) {
  const mode = document.querySelector("#expense-form").elements.splitMode.value;

  if (mode === "equal") {
    const selected = [
      ...document.querySelectorAll(".split-participant:checked"),
    ].map((input) => input.value);

    return splitEqually(amountCents, selected);
  }

  return [...document.querySelectorAll(".manual-share")]
    .map((input) => ({
      user_id: input.dataset.userId,
      share_cents: parseMoneyToCents(input.value),
    }))
    .filter((split) => split.share_cents > 0);
}

function splitEqually(amountCents, userIds) {
  if (!userIds.length) return [];

  const base = Math.floor(amountCents / userIds.length);
  let remainder = amountCents - base * userIds.length;

  return userIds.map((userId) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;

    return {
      user_id: userId,
      share_cents: base + extra,
    };
  });
}

async function handleCopyInvite(event) {
  const inviteUrl = event.currentTarget.dataset.inviteUrl;

  try {
    await navigator.clipboard.writeText(inviteUrl);
    state.notice = "Invite copied.";
    state.error = "";
    renderApp();
  } catch (error) {
    state.error = readableError(error);
    state.notice = "";
    renderApp();
  }
}

function prefillSettlement(dataset) {
  const panel = document.querySelector("#settlement-panel");
  const form = document.querySelector("#settlement-form");
  const currency = getSelectedGroup()?.currency || "USD";

  if (!panel || !form) return;

  form.elements.fromUser.value = dataset.from;
  form.elements.toUser.value = dataset.to;
  form.elements.amount.value = centsToInput(Number(dataset.amount), currency);
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function calculateStats(group) {
  const balances = new Map(state.members.map((member) => [member.user_id, 0]));
  let totalSpent = 0;

  for (const expense of state.expenses) {
    totalSpent += Number(expense.amount_cents || 0);
    balances.set(
      expense.paid_by,
      (balances.get(expense.paid_by) || 0) + Number(expense.amount_cents || 0),
    );

    for (const split of state.splitsByExpense.get(expense.id) || []) {
      balances.set(
        split.user_id,
        (balances.get(split.user_id) || 0) - Number(split.share_cents || 0),
      );
    }
  }

  for (const settlement of state.settlements) {
    balances.set(
      settlement.from_user,
      (balances.get(settlement.from_user) || 0) +
        Number(settlement.amount_cents || 0),
    );
    balances.set(
      settlement.to_user,
      (balances.get(settlement.to_user) || 0) -
        Number(settlement.amount_cents || 0),
    );
  }

  return {
    totalSpent,
    userBalance: balances.get(state.session.user.id) || 0,
    debts: simplifyDebts(balances).map((debt) => ({
      ...debt,
      currency: group.currency,
    })),
  };
}

function simplifyDebts(balances) {
  const debtors = [];
  const creditors = [];

  for (const [userId, amount] of balances) {
    if (amount < 0) debtors.push({ userId, amount: -amount });
    if (amount > 0) creditors.push({ userId, amount });
  }

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = Math.min(debtor.amount, creditor.amount);

    if (amount > 0) {
      transfers.push({
        from: debtor.userId,
        to: creditor.userId,
        amount,
      });
    }

    debtor.amount -= amount;
    creditor.amount -= amount;

    if (debtor.amount === 0) debtorIndex += 1;
    if (creditor.amount === 0) creditorIndex += 1;
  }

  return transfers;
}

function showAppError(error) {
  state.error = readableError(error);
  state.notice = "";
  renderApp();
}

function getSelectedGroup() {
  return state.groups.find((group) => group.id === state.selectedGroupId) || null;
}

function memberName(userId) {
  const member = state.members.find((item) => item.user_id === userId);
  return member?.profile?.display_name || `User ${String(userId).slice(0, 8)}`;
}

function initials(value) {
  const parts = normalizeText(value).split(/\s+/).filter(Boolean);
  const chars = parts.length > 1 ? [parts[0][0], parts[1][0]] : [value[0] || "U"];
  return chars.join("").toUpperCase().slice(0, 2);
}

function getCurrentPageUrl() {
  const url = new URL(window.location.href);
  url.hash = "";
  return url.toString();
}

function getInviteUrl(inviteCode) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("join", inviteCode);
  return url.toString();
}

function parseMoneyToCents(value) {
  const raw = normalizeText(value).replace(",", ".");

  if (!raw) return 0;
  if (!/^\d+(\.\d{0,2})?$/.test(raw)) {
    throw new Error("Use a valid money amount, for example 12.50.");
  }

  const [whole, fraction = ""] = raw.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
}

function centsToInput(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function formatMoney(cents, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(Number(cents || 0) / 100);
  } catch {
    return `${(Number(cents || 0) / 100).toFixed(2)} ${currency}`;
  }
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeText(value) {
  return String(value || "").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function safeJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function readableError(error) {
  return error?.message || error?.error_description || String(error);
}

function icon(name) {
  const paths = {
    check:
      '<path d="M20 6 9 17l-5-5"></path>',
    "chevron-right":
      '<path d="m9 18 6-6-6-6"></path>',
    copy:
      '<rect width="14" height="14" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>',
    link:
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>',
    "log-in":
      '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><path d="m10 17 5-5-5-5"></path><path d="M15 12H3"></path>',
    "log-out":
      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="m16 17 5-5-5-5"></path><path d="M21 12H9"></path>',
    mail:
      '<rect width="20" height="16" x="2" y="4" rx="2"></rect><path d="m22 7-10 5L2 7"></path>',
    bed:
      '<path d="M2 4v16"></path><path d="M2 10h20v10"></path><path d="M6 10V6h7a3 3 0 0 1 3 3v1"></path>',
    car:
      '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9L18 10l-2-4H8l-2 4-2.5 1.1C2.7 11.3 2 12.1 2 13v3c0 .6.4 1 1 1h2"></path><circle cx="7" cy="17" r="2"></circle><circle cx="17" cy="17" r="2"></circle>',
    plane:
      '<path d="M17.8 19.2 16 13l5-5c1.5-1.5 1.5-3.5.6-4.4s-2.9-.9-4.4.6l-5 5-6.2-1.8-1.7 1.7 5.2 3.2-3 3 1.2 1.2 3-3 3.2 5.2Z"></path>',
    plus:
      '<path d="M5 12h14"></path><path d="M12 5v14"></path>',
    receipt:
      '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"></path><path d="M16 8h-6"></path><path d="M16 12h-8"></path><path d="M16 16h-8"></path>',
    send:
      '<path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path>',
    settings:
      '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"></path><circle cx="12" cy="12" r="3"></circle>',
    trash:
      '<path d="M3 6h18"></path><path d="M8 6V4c0-1 .7-2 2-2h4c1.3 0 2 1 2 2v2"></path><path d="M19 6v14c0 1.1-.9 2-2 2H7c-1.1 0-2-.9-2-2V6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path>',
    utensils:
      '<path d="M4 3v8"></path><path d="M8 3v8"></path><path d="M4 7h4"></path><path d="M6 11v10"></path><path d="M18 3c-2 2-3 4.2-3 7v3h4v8"></path>',
    user:
      '<path d="M19 21a7 7 0 0 0-14 0"></path><circle cx="12" cy="7" r="4"></circle>',
    users:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
    wallet:
      '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3v4a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5"></path><path d="M18 12h.01"></path>',
  };

  return `
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      ${paths[name] || ""}
    </svg>
  `;
}
