// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://127.0.0.1:3003/pokemon';
const API  = `${BASE}/api`;
const PREFIX = 'pw-test-';

// ── helpers ──────────────────────────────────────────────────────────────────
function uid() { return `${PREFIX}${Date.now()}-${Math.floor(Math.random()*10000)}`; }

/** POST a card directly through the API and return its DB id */
async function apiCreateCard(request, overrides = {}) {
  const card = {
    card_id: uid(), name: 'Playwright Pikachu', number: '25',
    set_id: 'pl-set', set_name: 'Playwright Set',
    rarity: 'Common', types: 'Lightning',
    image_small: '', image_large: '', quantity: 1, wishlist: 0,
    ...overrides,
  };
  const res = await request.post(`${API}/cards`, { data: card });
  expect(res.ok()).toBeTruthy();
  return await res.json();   // { id, card_id, ... }
}

/** DELETE a card by DB id */
async function apiDeleteCard(request, id) {
  await request.delete(`${API}/cards/${id}`);
}

// Fake search result for intercepting the TCGDex proxy
const FAKE_SEARCH_CARD = {
  card_id: 'xy1-1', name: 'Venusaur-EX', number: '1',
  set_id: 'xy1', set_name: 'XY', set_total: 146,
  rarity: 'Rare Holo EX', types: 'Grass',
  image_small: 'https://assets.tcgdex.net/en/xy/xy1/1/low.webp',
  image_large: 'https://assets.tcgdex.net/en/xy/xy1/1/high.webp',
  illustrator: '', attacks: [], variants: {}, pricing: {},
};

// ── 1. Server-side language filter ───────────────────────────────────────────
test('1 – language filter: server returns only cards of requested language', async ({ request }) => {
  const cardPt = await apiCreateCard(request, { card_id: uid(), language: 'pt' });
  const cardEn = await apiCreateCard(request, { card_id: uid(), language: 'en' });

  try {
    // Patch language (POST doesn't set language; do it via PATCH)
    await request.patch(`${API}/cards/${cardPt.id}`, { data: { language: 'pt' } });
    await request.patch(`${API}/cards/${cardEn.id}`, { data: { language: 'en' } });

    const res = await request.get(`${API}/cards?language=pt`);
    const data = await res.json();
    const ids = data.cards.map(c => c.id);
    expect(ids).toContain(cardPt.id);
    expect(ids).not.toContain(cardEn.id);

    const resEn = await request.get(`${API}/cards?language=en`);
    const dataEn = await resEn.json();
    const idsEn = dataEn.cards.map(c => c.id);
    expect(idsEn).toContain(cardEn.id);
    expect(idsEn).not.toContain(cardPt.id);
  } finally {
    await apiDeleteCard(request, cardPt.id);
    await apiDeleteCard(request, cardEn.id);
  }
});

// ── 2. Pagination ─────────────────────────────────────────────────────────────
test('2 – pagination: GET /api/cards returns {cards, total} with limit/offset', async ({ request }) => {
  // Create 5 cards all in a unique set so we can filter to only our test data
  const setId = `pl-set-${Date.now()}`;
  const created = [];
  for (let i = 0; i < 5; i++) {
    const c = await apiCreateCard(request, { card_id: uid(), set_id: setId, set_name: setId, number: String(i + 1) });
    created.push(c);
  }

  try {
    // Page 1: limit=3, offset=0
    const p1 = await (await request.get(`${API}/cards?set_id=${setId}&limit=3&offset=0`)).json();
    expect(p1.total).toBe(5);
    expect(p1.cards).toHaveLength(3);

    // Page 2: limit=3, offset=3
    const p2 = await (await request.get(`${API}/cards?set_id=${setId}&limit=3&offset=3`)).json();
    expect(p2.total).toBe(5);
    expect(p2.cards).toHaveLength(2);

    // All IDs across both pages are distinct
    const allIds = [...p1.cards, ...p2.cards].map(c => c.id);
    expect(new Set(allIds).size).toBe(5);
  } finally {
    for (const c of created) await apiDeleteCard(request, c.id);
  }
});

test('2b – pagination UI: prev/next buttons appear with >60 cards and navigate', async ({ request, page }) => {
  const setId = `pl-pg-${Date.now()}`;
  const created = [];
  // Create 65 cards to trigger pagination (PAGE_SIZE = 60)
  for (let i = 0; i < 65; i++) {
    const c = await apiCreateCard(request, {
      card_id: uid(), set_id: setId, set_name: setId, number: String(i + 1),
    });
    created.push(c);
  }

  try {
    await page.goto(BASE);
    // Filter to our test set
    await page.evaluate((sid) => {
      document.getElementById('filterSearch').value = sid;
    }, setId);
    await page.evaluate(() => window.debounceLoadCards());
    await page.waitForTimeout(600);

    const pb = page.locator('#paginationBar');
    await expect(pb).toBeVisible();
    await expect(page.locator('#pageIndicator')).toContainText('Página 1 de 2');

    // Prev button disabled on page 1
    await expect(page.locator('#prevPageBtn')).toBeDisabled();
    await expect(page.locator('#nextPageBtn')).not.toBeDisabled();

    // Navigate to page 2
    await page.locator('#nextPageBtn').click();
    await page.waitForTimeout(400);
    await expect(page.locator('#pageIndicator')).toContainText('Página 2 de 2');
    await expect(page.locator('#nextPageBtn')).toBeDisabled();
    await expect(page.locator('#prevPageBtn')).not.toBeDisabled();

    // Cards grid shows the remaining 5 cards
    const cardItems = page.locator('#cardsGrid .card-item');
    await expect(cardItems).toHaveCount(5);
  } finally {
    for (const c of created) await apiDeleteCard(request, c.id);
  }
});

// ── 3. Duplicate card warning ─────────────────────────────────────────────────
test('3 – duplicate card warning shown in openAdd modal', async ({ request, page }) => {
  // Add a card to the collection so it exists in `cards`
  const cardId = 'xy1-1'; // same as FAKE_SEARCH_CARD
  let created = null;
  try {
    const res = await request.post(`${API}/cards`, {
      data: { card_id: cardId, name: 'Venusaur-EX', number: '1', set_id: 'xy1', set_name: 'XY', rarity: 'Rare', types: 'Grass', image_small: '', image_large: '', quantity: 1, wishlist: 0 },
    });
    created = await res.json();
  } catch {}

  // Intercept TCGDex search
  await page.route(`**/api/search**`, route => {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [FAKE_SEARCH_CARD], total: 1 }) });
  });

  await page.goto(`${BASE}#search`);
  await page.evaluate(() => window.showTab('search', null));
  await page.waitForTimeout(300);

  // Trigger search
  await page.fill('#searchInput', 'Venusaur-EX');
  await page.click('button:has-text("Buscar")');
  await page.waitForTimeout(500);

  // Click the search result to open the add modal
  await page.locator('#searchResults .card-item').first().click();
  await page.waitForTimeout(200);

  // Duplicate warning banner should be visible
  const warning = page.locator('#addOverlay').locator('text=já na');
  await expect(warning).toBeVisible();

  if (created) await apiDeleteCard(request, created.id);
});

// ── 4. Select-all in card search ─────────────────────────────────────────────
test('4 – cardResultBar with "Selecionar todas" appears after doSearch', async ({ page }) => {
  await page.route(`**/api/search**`, route => {
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        results: [FAKE_SEARCH_CARD, { ...FAKE_SEARCH_CARD, card_id: 'xy1-2', name: 'M Venusaur-EX', number: '2' }],
        total: 2,
      }),
    });
  });

  await page.goto(BASE);
  await page.evaluate(() => window.showTab('search', null));
  await page.waitForTimeout(300);

  await page.fill('#searchInput', 'Venusaur');
  await page.click('button:has-text("Buscar")');
  await page.waitForTimeout(500);

  // cardResultBar should be visible
  const bar = page.locator('#cardResultBar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('2 resultado');

  // "Selecionar todas" button present
  const btn = page.locator('#cardSelectAllBtn');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveText('Selecionar todas');

  // Click it — selects all
  await btn.click();
  await page.waitForTimeout(200);
  await expect(btn).toHaveText('Desmarcar todas');

  // Action bar appears with 2 selected
  await expect(page.locator('#searchActionBar')).toBeVisible();
  await expect(page.locator('#searchSelCount')).toContainText('2');

  // Click again — deselects all
  await btn.click();
  await page.waitForTimeout(200);
  await expect(btn).toHaveText('Selecionar todas');
});

// ── 5. Flash-saved animation on price edit ────────────────────────────────────
test('5 – flash-saved class applied to input after price save', async ({ request, page }) => {
  const card = await apiCreateCard(request, { card_id: uid() });

  try {
    await page.goto(BASE);
    await page.waitForTimeout(500);

    // Open the card detail
    await page.evaluate((id) => {
      const idx = window.cards.findIndex(c => c.id === id);
      if (idx >= 0) window.viewCard(idx);
    }, card.id);
    await page.waitForTimeout(300);

    // Find "Paguei" input and change value
    const paidInput = page.locator('.price-input').filter({ hasText: '' }).nth(0);

    // Intercept the PATCH so it responds quickly
    await page.route(`**/api/cards/${card.id}`, route => {
      if (route.request().method() === 'PATCH') {
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: card.id }) });
      } else route.continue();
    });

    // Trigger change on the first price-input inside detailModal
    await page.evaluate((id) => {
      const inputs = document.querySelectorAll('#detailModal .price-input');
      if (inputs.length > 0) {
        const inp = inputs[0];
        inp.value = '9.99';
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, card.id);

    // flash-saved class should be applied briefly
    await expect(page.locator('#detailModal .price-input').first()).toHaveClass(/flash-saved/, { timeout: 2000 });
  } finally {
    await apiDeleteCard(request, card.id);
  }
});

// ── 6. Batch modal labels ─────────────────────────────────────────────────────
test('6 – batch modal Qtd label is gold in wishlist mode, plain in collection mode', async ({ page }) => {
  await page.route(`**/api/search**`, route => {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [FAKE_SEARCH_CARD], total: 1 }) });
  });

  await page.goto(BASE);
  await page.evaluate(() => window.showTab('search', null));
  await page.waitForTimeout(300);
  await page.fill('#searchInput', 'Venusaur');
  await page.click('button:has-text("Buscar")');
  await page.waitForTimeout(500);

  // Select the card
  await page.locator('#searchResults .card-check').first().click();
  await page.waitForTimeout(200);

  // Open batch modal in COLLECTION mode (wishlist=0)
  await page.locator('#searchActionBar button:has-text("Coleção")').click();
  await page.waitForTimeout(300);

  // In collection mode, Qtd label should have no color style (plain)
  const collLabel = page.locator('#batchCardsList .batch-inp-g label').first();
  await expect(collLabel).toHaveText('Qtd');
  const collColor = await collLabel.getAttribute('style');
  expect(collColor || '').not.toContain('var(--gold)');

  // Close and reopen in WISHLIST mode
  await page.click('button:has-text("Cancelar")');
  await page.waitForTimeout(200);
  await page.locator('#searchActionBar button:has-text("Wishlist")').click();
  await page.waitForTimeout(300);

  // In wishlist mode, Qtd label should have gold color
  const wishLabel = page.locator('#batchCardsList .batch-inp-g label').first();
  await expect(wishLabel).toHaveText('Qtd');
  const wishColor = await wishLabel.getAttribute('style');
  expect(wishColor || '').toContain('var(--gold)');

  await page.click('button:has-text("Cancelar")');
});

// ── 7. Negative price validation ──────────────────────────────────────────────
test('7a – savePurchase blocks negative price', async ({ page }) => {
  await page.goto(BASE);
  await page.evaluate(() => window.showTab('purchases', null));
  await page.waitForTimeout(300);

  await page.click('button:has-text("Nova Compra")');
  await page.waitForTimeout(200);

  await page.fill('#pName', 'Test Booster');
  await page.fill('#pPrice', '-10');

  await page.click('button:has-text("Salvar")');
  await page.waitForTimeout(300);

  // Toast with error should appear
  const toast = page.locator('#toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('negativo');

  // Modal stays open (purchase not saved)
  await expect(page.locator('#purchaseOverlay')).toHaveClass(/show/);
  await page.press('body', 'Escape');
});

test('7b – saveCard blocks negative paid price', async ({ page }) => {
  await page.route(`**/api/search**`, route => {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [FAKE_SEARCH_CARD], total: 1 }) });
  });

  await page.goto(BASE);
  await page.evaluate(() => window.showTab('search', null));
  await page.waitForTimeout(300);
  await page.fill('#searchInput', 'Venusaur');
  await page.click('button:has-text("Buscar")');
  await page.waitForTimeout(500);

  // Open add modal
  await page.locator('#searchResults .card-item').first().click();
  await page.waitForTimeout(200);

  // Set negative price
  await page.fill('#addPrice', '-5');
  await page.click('button:has-text("Salvar")');
  await page.waitForTimeout(300);

  const toast = page.locator('#toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('negativo');
  await expect(page.locator('#addOverlay')).toHaveClass(/show/);
  await page.press('body', 'Escape');
});

test('7c – saveBatchCards blocks negative price', async ({ page }) => {
  await page.route(`**/api/search**`, route => {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [FAKE_SEARCH_CARD], total: 1 }) });
  });

  await page.goto(BASE);
  await page.evaluate(() => window.showTab('search', null));
  await page.waitForTimeout(300);
  await page.fill('#searchInput', 'Venusaur');
  await page.click('button:has-text("Buscar")');
  await page.waitForTimeout(500);

  // Select and open batch modal (collection mode)
  await page.locator('#searchResults .card-check').first().click();
  await page.waitForTimeout(200);
  await page.locator('#searchActionBar button:has-text("Coleção")').click();
  await page.waitForTimeout(300);

  // Enter negative price in first price field
  await page.locator('#batchCardsList input[id^="bprice-"]').first().fill('-3');
  await page.locator('#batchSaveBtn').click();
  await page.waitForTimeout(300);

  const toast = page.locator('#toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('negativo');

  await page.press('body', 'Escape');
});

// ── 8. loadPurchases called after saveCard ────────────────────────────────────
test('8 – loadPurchases is called after saveCard succeeds', async ({ request, page }) => {
  await page.route(`**/api/search**`, route => {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [{ ...FAKE_SEARCH_CARD, card_id: uid() }], total: 1 }) });
  });

  // Track if /api/purchases was fetched after saving
  let purchasesFetched = false;
  await page.route(`**/api/purchases`, route => {
    if (route.request().method() === 'GET') purchasesFetched = true;
    route.continue();
  });

  await page.goto(BASE);
  await page.evaluate(() => window.showTab('search', null));
  await page.waitForTimeout(300);
  await page.fill('#searchInput', 'Venusaur');
  await page.click('button:has-text("Buscar")');
  await page.waitForTimeout(500);

  await page.locator('#searchResults .card-item').first().click();
  await page.waitForTimeout(200);

  purchasesFetched = false;
  await page.click('button:has-text("Salvar")');
  await page.waitForTimeout(800);

  expect(purchasesFetched).toBe(true);

  // Clean up: find and delete the newly added card
  const res = await request.get(`${API}/cards?limit=1&offset=0&sort=added`);
  const data = await res.json();
  if (data.cards?.length && data.cards[0].name === 'Venusaur-EX') {
    await apiDeleteCard(request, data.cards[0].id);
  }
});

// ── 9. Duplicate POST does not overwrite wishlist ────────────────────────────
test('9 – re-adding a wishlist card as collection does not overwrite wishlist=1', async ({ request }) => {
  const cardId = uid();
  // Create as wishlist
  const created = await apiCreateCard(request, { card_id: cardId, wishlist: 1 });
  expect(created.id).toBeTruthy();

  try {
    // PATCH to confirm wishlist=1
    await request.patch(`${API}/cards/${created.id}`, { data: { wishlist: 1 } });

    // Re-POST the same card as collection (wishlist=0)
    const rePost = await request.post(`${API}/cards`, {
      data: { card_id: cardId, name: 'Playwright Pikachu', number: '25', set_id: 'pl-set', set_name: 'Playwright Set', rarity: 'Common', types: 'Lightning', image_small: '', image_large: '', quantity: 1, wishlist: 0 },
    });
    const updated = await rePost.json();

    // Wishlist should still be 1 (not overwritten)
    expect(updated.wishlist).toBe(1);
    // Quantity should have incremented
    expect(updated.quantity).toBe(2);
  } finally {
    await apiDeleteCard(request, created.id);
  }
});
