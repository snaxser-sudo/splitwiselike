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
      "Новый участник";

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
  state.notice = "Приглашение принято.";
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
              <h2>Подключение Supabase</h2>
              <p>URL проекта и publishable key</p>
            </div>
            ${icon("settings")}
          </div>
          <div class="field">
            <label for="supabase-url">URL проекта</label>
            <input id="supabase-url" name="supabaseUrl" type="url" placeholder="https://..." required />
          </div>
          <div class="field">
            <label for="supabase-key">Publishable key</label>
            <input id="supabase-key" name="supabasePublishableKey" type="password" autocomplete="off" required />
          </div>
          <button class="button primary" type="submit">${icon("check")}Подключить</button>
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
        <div class="split-steps">
          <span><strong>1</strong>Добавьте трату</span>
          <span><strong>2</strong>Выберите участников</span>
          <span><strong>3</strong>Сведите долги к одному переводу</span>
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
          <nav class="group-tabs" aria-label="Группы">
            ${state.groups.map(renderGroupTab).join("")}
          </nav>
          ${renderGroupSelect()}
          <div class="account-menu">
            <span class="avatar" title="${escapeAttribute(state.profile?.display_name || "Аккаунт")}">${escapeHtml(initials(state.profile?.display_name || state.session?.user?.email || "U"))}</span>
            <button class="icon-button" data-action="sign-out" title="Выйти" aria-label="Выйти">${icon("log-out")}</button>
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

function renderGroupSelect() {
  if (!state.groups.length) {
    return `
      <select class="group-select" aria-label="Выбрать поездку" disabled>
        <option>Нет поездок</option>
      </select>
    `;
  }

  return `
    <select class="group-select" data-action="select-group-menu" aria-label="Выбрать поездку">
      ${state.groups
        .map(
          (group) => `
            <option value="${escapeAttribute(group.id)}" ${group.id === state.selectedGroupId ? "selected" : ""}>
              ${escapeHtml(group.name)}
            </option>
          `,
        )
        .join("")}
    </select>
  `;
}

function renderGroupsPanel() {
  return `
    <section class="panel groups-panel">
      <div class="panel-header">
        <div>
          <h2>Поездки</h2>
          <p>${state.groups.length ? `${state.groups.length} активных` : "Создайте первый маршрут"}</p>
        </div>
        ${icon("plane")}
      </div>
      <div class="group-list">
        ${state.groups.map(renderGroupListItem).join("") || `<div class="side-empty">Пока нет поездок.</div>`}
      </div>
    </section>
    <section class="panel new-group-panel">
      <div class="panel-header">
        <div>
          <h2>Новая поездка</h2>
          <p>Название и общая валюта</p>
        </div>
        ${icon("plus")}
      </div>
      <form id="group-form">
        <div class="field">
          <label for="group-name">Название</label>
          <input id="group-name" name="name" placeholder="Стамбул на майские" required maxlength="80" />
        </div>
        <div class="field">
          <label for="group-currency">Валюта</label>
          <select id="group-currency" name="currency">
            ${["USD", "EUR", "GBP", "PLN", "UAH", "RUB", "GEL", "TRY"].map((currency) => `<option value="${currency}">${currency}</option>`).join("")}
          </select>
        </div>
        <button class="button primary" type="submit">${icon("plus")}Создать</button>
      </form>
    </section>
    <section class="panel join-panel">
      <div class="panel-header">
        <div>
          <h2>Присоединиться</h2>
          <p>Код приглашения</p>
        </div>
        ${icon("link")}
      </div>
      <form id="join-form">
        <div class="field">
          <label for="invite-code">Код</label>
          <input id="invite-code" name="inviteCode" placeholder="Например, a1b2c3" autocomplete="off" required />
        </div>
        <button class="button secondary" type="submit">${icon("log-in")}Войти</button>
      </form>
    </section>
  `;
}

function renderGroupListItem(group) {
  const active = group.id === state.selectedGroupId ? "active" : "";

  return `
    <button class="trip-list-item ${active}" type="button" data-action="select-group" data-group-id="${escapeAttribute(group.id)}">
      <span class="trip-list-main">
        <span class="trip-list-icon">${icon("plane")}</span>
        <span>
          <strong>${escapeHtml(group.name)}</strong>
          <span>Маршрут в ${escapeHtml(group.currency)}</span>
        </span>
      </span>
      <span class="trip-list-currency">
        <span>${escapeHtml(group.currency)}</span>
        ${icon("chevron-right")}
      </span>
    </button>
  `;
}

function renderProfilePanel() {
  const displayName = state.profile?.display_name || state.session?.user?.email || "";

  return `
    <section class="panel profile-panel">
      <div class="profile-card-head">
        <span class="profile-avatar">${escapeHtml(initials(displayName || "ТС"))}</span>
        <div>
          <h2>Профиль</h2>
          <p>${escapeHtml(state.session?.user?.email || "")}</p>
        </div>
      </div>
      <form id="profile-form">
        <div class="field">
          <label for="display-name">Имя в поездках</label>
          <input id="display-name" name="displayName" value="${escapeAttribute(state.profile?.display_name || "")}" required maxlength="80" />
        </div>
        <button class="button secondary" type="submit">${icon("check")}Сохранить</button>
      </form>
    </section>
  `;
}

function renderEmptyWorkspace() {
  return `
    <section class="empty-state empty-workspace">
      <div>
        <span class="empty-icon">${icon("plane")}</span>
        <h2>Выберите поездку</h2>
        <p>Создайте маршрут или присоединитесь по коду приглашения, чтобы начать делить расходы.</p>
      </div>
    </section>
  `;
}

function renderGroupWorkspace(group) {
  const stats = calculateStats(group);

  return `
    <section class="main-grid settlement-page">
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
    <div class="workspace-feedback">
      ${state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : ""}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ""}
    </div>
  `;
}

function renderGroupHero(group) {
  const inviteUrl = getInviteUrl(group.invite_code);

  return `
    <section class="group-hero trip-hero">
      <div class="hero-row trip-hero-row">
        <div class="trip-hero-copy">
          <span class="eyebrow">${icon("plane")}Маршрут поездки</span>
          <h1>${escapeHtml(group.name)}</h1>
          <p>Добавляйте общие траты, отмечайте переводы и сразу видьте, как закрыть долги без лишней математики.</p>
        </div>
        <div class="invite-box trip-invite-card">
          <span>Приглашение в поездку</span>
          <strong class="code" title="${escapeAttribute(inviteUrl)}">${escapeHtml(group.invite_code)}</strong>
          <button class="button secondary" type="button" data-action="copy-invite" data-invite-url="${escapeAttribute(inviteUrl)}" title="Скопировать приглашение" aria-label="Скопировать приглашение">${icon("copy")}Скопировать</button>
        </div>
      </div>
      <div class="trip-meta-row">
        <span>${icon("wallet")}${escapeHtml(group.currency)}</span>
        <span>${icon("users")}${state.members.length} участников</span>
        <span>${icon("receipt")}${state.expenses.length} расходов</span>
      </div>
    </section>
  `;
}

function renderSummary(group, stats) {
  const balance = stats.userBalance;
  const balanceClass = balance > 0 ? "positive" : balance < 0 ? "negative" : "neutral";
  const balanceLabel =
    balance > 0 ? "Вам вернут" : balance < 0 ? "Вы должны" : "Вы в расчете";

  return `
    <section class="summary-grid settlement-summary">
      <div class="summary-tile neutral">
        <span>${icon("receipt")}Всего потрачено</span>
        <strong>${formatMoney(stats.totalSpent, group.currency)}</strong>
        <small>по всем расходам поездки</small>
      </div>
      <div class="summary-tile ${balanceClass}">
        <span>${icon("wallet")}${balanceLabel}</span>
        <strong>${formatMoney(Math.abs(balance), group.currency)}</strong>
        <small>ваш личный баланс</small>
      </div>
      <div class="summary-tile neutral alt">
        <span>${icon("send")}Нужно переводов</span>
        <strong>${stats.debts.length}</strong>
        <small>после упрощения долгов</small>
      </div>
    </section>
  `;
}

function renderMembers() {
  return `
    <section class="panel members-panel">
      <div class="panel-header">
        <div>
          <h2>Попутчики</h2>
          <p>${state.members.length} человек в поездке</p>
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
      ${member.role === "owner" ? `<span class="chip">создатель</span>` : ""}
    </span>
  `;
}

function renderDebts(group, debts) {
  return `
    <section class="panel settle-board">
      <div class="panel-header">
        <div>
          <h2>Взаиморасчеты</h2>
          <p>${debts.length ? "Минимальный набор переводов" : "Все уже в расчете"}</p>
        </div>
        ${icon("wallet")}
      </div>
      <div class="debt-list">
        ${
          debts
            .map(
              (debt) => `
                <div class="debt-item transfer-card">
                  <div class="debt-line transfer-route">
                    <span class="mini-avatar">${escapeHtml(initials(memberName(debt.from)))}</span>
                    <div>
                      <strong>${escapeHtml(memberName(debt.from))}</strong>
                      <span>переводит</span>
                    </div>
                    <span class="transfer-arrow">${icon("send")}</span>
                    <span class="mini-avatar">${escapeHtml(initials(memberName(debt.to)))}</span>
                    <div>
                      <strong>${escapeHtml(memberName(debt.to))}</strong>
                      <span>получает</span>
                    </div>
                  </div>
                  <div class="transfer-side">
                    <strong class="amount">${formatMoney(debt.amount, group.currency)}</strong>
                    <button class="button secondary" type="button" data-action="prefill-settlement" data-from="${escapeAttribute(debt.from)}" data-to="${escapeAttribute(debt.to)}" data-amount="${debt.amount}">
                      ${icon("check")}Записать
                    </button>
                  </div>
                </div>
              `,
            )
            .join("") ||
          `<div class="empty-state inline-empty"><div><span class="empty-icon">${icon("check")}</span><h3>Все в расчете</h3><p>Сейчас никому ничего переводить не нужно.</p></div></div>`
        }
      </div>
    </section>
  `;
}

function renderExpenses(group) {
  return `
    <section class="panel expenses-board">
      <div class="panel-header">
        <div>
          <h2>Лента расходов</h2>
          <p>${state.expenses.length ? `${state.expenses.length} записей` : "Пока пусто"}</p>
        </div>
        ${icon("receipt")}
      </div>
      <div class="expense-list">
        ${state.expenses.map((expense) => renderExpenseItem(expense, group)).join("") || `<div class="empty-state inline-empty"><div><span class="empty-icon">${icon("receipt")}</span><h3>Расходов пока нет</h3><p>Добавьте первую общую трату.</p></div></div>`}
      </div>
    </section>
  `;
}

function renderExpenseItem(expense, group) {
  const splits = state.splitsByExpense.get(expense.id) || [];

  return `
    <article class="expense-item expense-ticket">
      <div class="expense-head">
        <span class="expense-ticket-icon">${icon("receipt")}</span>
        <div class="expense-title">
          <strong>${escapeHtml(expense.title)}</strong>
          <span>Оплатил ${escapeHtml(memberName(expense.paid_by))} • ${formatDate(expense.spent_at)}</span>
        </div>
        <div class="toolbar">
          <strong>${formatMoney(expense.amount_cents, expense.currency || group.currency)}</strong>
          <button class="icon-button danger" type="button" data-action="delete-expense" data-expense-id="${escapeAttribute(expense.id)}" title="Удалить расход" aria-label="Удалить расход">${icon("trash")}</button>
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
    <section class="panel action-card expense-action">
      <div class="panel-header">
        <div>
          <h2>Добавить трату</h2>
          <p>Быстрая запись в ${escapeHtml(group.currency)}</p>
        </div>
        ${icon("plus")}
      </div>
      <form id="expense-form">
        <div class="field">
          <label for="expense-title">За что</label>
          <input id="expense-title" name="title" placeholder="Отель у моря" required maxlength="140" />
        </div>
        <div class="two-fields">
          <div class="field">
            <label for="expense-amount">Сколько</label>
            <input id="expense-amount" name="amount" inputmode="decimal" placeholder="42.50" required />
          </div>
          <div class="field">
            <label for="expense-date">Дата</label>
            <input id="expense-date" name="spentAt" type="date" value="${today}" required />
          </div>
        </div>
        <div class="field">
          <label for="expense-paid-by">Кто оплатил</label>
          <select id="expense-paid-by" name="paidBy" required>
            ${state.members.map((member) => `<option value="${escapeAttribute(member.user_id)}">${escapeHtml(memberName(member.user_id))}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <span class="field-label">Как делим</span>
          <div class="segmented">
            <input id="split-equal" type="radio" name="splitMode" value="equal" checked />
            <label for="split-equal">Поровну</label>
            <input id="split-manual" type="radio" name="splitMode" value="manual" />
            <label for="split-manual">Вручную</label>
          </div>
        </div>
        <div id="split-editor" class="split-editor"></div>
        <div id="split-preview" class="split-preview"></div>
        <div class="field">
          <label for="expense-notes">Заметка</label>
          <textarea id="expense-notes" name="notes" placeholder="Например, бронь на две ночи"></textarea>
        </div>
        <button class="button primary" type="submit">${icon("check")}Добавить трату</button>
      </form>
    </section>
  `;
}

function renderSettlementForm(group) {
  return `
    <section class="panel action-card settlement-action" id="settlement-panel">
      <div class="panel-header">
        <div>
          <h2>Записать перевод</h2>
          <p>Закрываем долг в ${escapeHtml(group.currency)}</p>
        </div>
        ${icon("wallet")}
      </div>
      <form id="settlement-form">
        <div class="two-fields">
          <div class="field">
            <label for="settlement-from">От кого</label>
            <select id="settlement-from" name="fromUser" required>
              ${state.members.map((member) => `<option value="${escapeAttribute(member.user_id)}">${escapeHtml(memberName(member.user_id))}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="settlement-to">Кому</label>
            <select id="settlement-to" name="toUser" required>
              ${state.members.map((member) => `<option value="${escapeAttribute(member.user_id)}">${escapeHtml(memberName(member.user_id))}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="two-fields">
          <div class="field">
            <label for="settlement-amount">Сумма</label>
            <input id="settlement-amount" name="amount" inputmode="decimal" placeholder="25.00" required />
          </div>
          <div class="field">
            <label for="settlement-date">Дата</label>
            <input id="settlement-date" name="settledAt" type="date" value="${todayISO()}" required />
          </div>
        </div>
        <button class="button secondary" type="submit">${icon("check")}Записать</button>
      </form>
    </section>
  `;
}

function renderSettlements(group) {
  return `
    <section class="panel payments-history">
      <div class="panel-header">
        <div>
          <h2>Лента переводов</h2>
          <p>${state.settlements.length ? `${state.settlements.length} записей` : "Переводов пока нет"}</p>
        </div>
        ${icon("send")}
      </div>
      <div class="settlement-list">
        ${
          state.settlements
            .map(
              (settlement) => `
                <div class="settlement-row payment-ticket">
                  <div class="payment-route">
                    <span class="mini-avatar">${escapeHtml(initials(memberName(settlement.from_user)))}</span>
                    <div>
                      <strong>${escapeHtml(memberName(settlement.from_user))}</strong>
                      <span>${formatDate(settlement.settled_at)}</span>
                    </div>
                    <span class="transfer-arrow">${icon("send")}</span>
                    <span class="mini-avatar">${escapeHtml(initials(memberName(settlement.to_user)))}</span>
                    <div>
                      <strong>${escapeHtml(memberName(settlement.to_user))}</strong>
                      <span>получил перевод</span>
                    </div>
                  </div>
                  <div class="toolbar">
                    <strong>${formatMoney(settlement.amount_cents, settlement.currency || group.currency)}</strong>
                    <button class="icon-button danger" type="button" data-action="delete-settlement" data-settlement-id="${escapeAttribute(settlement.id)}" title="Удалить перевод" aria-label="Удалить перевод">${icon("trash")}</button>
                  </div>
                </div>
              `,
            )
            .join("") || `<div class="empty-state inline-empty"><div><span class="empty-icon">${icon("send")}</span><h3>Переводов пока нет</h3><p>Запишите перевод, когда кто-то закроет долг.</p></div></div>`
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
    button.addEventListener("click", () => selectGroup(button.dataset.groupId));
  });

  document
    .querySelector("[data-action='select-group-menu']")
    ?.addEventListener("change", (event) => selectGroup(event.currentTarget.value));

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

async function selectGroup(groupId) {
  if (!groupId || groupId === state.selectedGroupId) return;

  try {
    state.selectedGroupId = groupId;
    state.notice = "";
    state.error = "";
    await loadWorkspace(state.selectedGroupId);
    renderApp();
  } catch (error) {
    showAppError(error);
  }
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

    state.notice = "Поездка создана.";
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

    state.notice = "Вы присоединились к поездке.";
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
    state.notice = "Профиль сохранен.";
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
    if (amountCents <= 0) throw new Error("Сумма должна быть больше нуля.");

    const splits = readSplitsFromForm(amountCents);
    const splitTotal = splits.reduce((sum, split) => sum + split.share_cents, 0);

    if (!splits.length) throw new Error("Выберите хотя бы одного участника.");
    if (splitTotal !== amountCents) {
      const difference = amountCents - splitTotal;
      const currency = group?.currency || "USD";
      const direction = difference > 0 ? "не хватает" : "лишние";
      window.alert(
        `Сумма не сходится: ${direction} ${formatMoney(Math.abs(difference), currency)}. Проверьте ручное деление.`,
      );
      return;
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

    state.notice = "Трата добавлена.";
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

    if (amountCents <= 0) throw new Error("Сумма должна быть больше нуля.");

    const { error } = await supabase.rpc("create_settlement", {
      p_group_id: group.id,
      p_from_user: normalizeText(form.get("fromUser")),
      p_to_user: normalizeText(form.get("toUser")),
      p_amount_cents: amountCents,
      p_currency: group.currency,
      p_settled_at: normalizeText(form.get("settledAt")),
    });

    if (error) throw error;

    state.notice = "Перевод записан.";
    state.error = "";
    await loadWorkspace(group.id);
    renderApp();
  } catch (error) {
    showAppError(error);
  }
}

async function deleteExpense(expenseId) {
  if (!window.confirm("Удалить эту трату?")) return;

  try {
    const { error } = await supabase.from("expenses").delete().eq("id", expenseId);
    if (error) throw error;

    state.notice = "Трата удалена.";
    state.error = "";
    await loadWorkspace(state.selectedGroupId);
    renderApp();
  } catch (error) {
    showAppError(error);
  }
}

async function deleteSettlement(settlementId) {
  if (!window.confirm("Удалить этот перевод?")) return;

  try {
    const { error } = await supabase
      .from("settlements")
      .delete()
      .eq("id", settlementId);

    if (error) throw error;

    state.notice = "Перевод удален.";
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

    preview.className = selected.length
      ? "split-preview balanced"
      : "split-preview mismatch";
    preview.textContent = selected.length
      ? `Поровну между участниками: ${selected.length}`
      : "Выберите хотя бы одного участника";
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

  const currency = getSelectedGroup()?.currency || "USD";
  const difference = amountCents - manualTotal;
  preview.className = difference === 0
    ? "split-preview balanced"
    : "split-preview mismatch";
  preview.textContent = difference === 0
    ? `Ручная сумма сошлась: ${formatMoney(manualTotal, currency)}`
    : `Ручная сумма: ${formatMoney(manualTotal, currency)}. ${difference > 0 ? "Не хватает" : "Лишние"} ${formatMoney(Math.abs(difference), currency)}.`;
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
    state.notice = "Приглашение скопировано.";
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
  return member?.profile?.display_name || `Участник ${String(userId).slice(0, 8)}`;
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
    throw new Error("Введите корректную сумму, например 12.50.");
  }

  const [whole, fraction = ""] = raw.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
}

function centsToInput(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function formatMoney(cents, currency) {
  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
    }).format(Number(cents || 0) / 100);
  } catch {
    return `${(Number(cents || 0) / 100).toFixed(2)} ${currency}`;
  }
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ru-RU", {
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
