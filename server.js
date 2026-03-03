const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = 3003;
const BASE_PATH = '/pokemon';
const TCGDEX_API = 'https://api.tcgdex.net/v2/en';

app.use(express.json());

// Database
const db = new Database(path.join(__dirname, 'pokemon.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    number TEXT NOT NULL,
    set_id TEXT NOT NULL,
    set_name TEXT NOT NULL,
    rarity TEXT,
    types TEXT,
    image_small TEXT,
    image_large TEXT,
    full_data TEXT DEFAULT '{}',
    quantity INTEGER DEFAULT 1,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#ff4757',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS card_tags (
    card_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (card_id, tag_id),
    FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'booster',
    price REAL NOT NULL DEFAULT 0,
    date DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS card_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    purchase_id INTEGER,
    price REAL NOT NULL DEFAULT 0,
    price_mode TEXT NOT NULL DEFAULT 'manual',
    quantity INTEGER DEFAULT 1,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE SET NULL
  );
`);

// Migration: move old collection-based cards to new schema
try {
  const oldCards = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='collections'").get();
  if (oldCards) {
    // Cards already exist in the old schema - migrate unique cards
    const existing = db.prepare("SELECT COUNT(*) as c FROM cards WHERE card_id NOT IN (SELECT card_id FROM cards GROUP BY card_id HAVING COUNT(*)>1)").get();
    // Drop old tables if they exist after migration
    // We keep cards table as-is since we recreated it with UNIQUE on card_id
  }
} catch(e) {}

// Ensure card_id is unique (migration from old schema)
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_card_id ON cards(card_id)`);
} catch(e) {}

// Migration: add language column
try {
  db.exec(`ALTER TABLE cards ADD COLUMN language TEXT NOT NULL DEFAULT 'pt'`);
} catch(e) {} // column already exists

// Migration: add value column (market/estimated value)
try {
  db.exec(`ALTER TABLE cards ADD COLUMN value REAL NOT NULL DEFAULT 0`);
} catch(e) {} // column already exists

// Migration: add paid column (what was paid for the card)
try {
  db.exec(`ALTER TABLE cards ADD COLUMN paid REAL NOT NULL DEFAULT 0`);
} catch(e) {} // column already exists

// Migration: add wishlist column
try {
  db.exec(`ALTER TABLE cards ADD COLUMN wishlist INTEGER NOT NULL DEFAULT 0`);
} catch(e) {} // column already exists

// Migration: remove collection_id column (from old schema)
try {
  // Check if collection_id exists
  const cols = db.prepare("PRAGMA table_info(cards)").all();
  const hasCollectionId = cols.some(c => c.name === 'collection_id');
  
  if (hasCollectionId) {
    console.log('🔄 Migration: Removing collection_id column...');
    db.exec(`
      BEGIN TRANSACTION;
      
      CREATE TABLE cards_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        number TEXT NOT NULL,
        set_id TEXT NOT NULL,
        set_name TEXT NOT NULL,
        rarity TEXT,
        types TEXT,
        image_small TEXT,
        image_large TEXT,
        full_data TEXT DEFAULT '{}',
        quantity INTEGER DEFAULT 1,
        language TEXT NOT NULL DEFAULT 'pt',
        value REAL NOT NULL DEFAULT 0,
        paid REAL NOT NULL DEFAULT 0,
        wishlist INTEGER NOT NULL DEFAULT 0,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      INSERT INTO cards_new (id, card_id, name, number, set_id, set_name, rarity, types, image_small, image_large, full_data, quantity, language, value, paid, wishlist, added_at)
      SELECT id, card_id, name, number, set_id, set_name, rarity, types, image_small, image_large, full_data, quantity, 
             COALESCE(language, 'pt'), COALESCE(value, 0), COALESCE(paid, 0), COALESCE(wishlist, 0), added_at
      FROM cards;
      
      DROP TABLE cards;
      ALTER TABLE cards_new RENAME TO cards;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_card_id ON cards(card_id);
      
      COMMIT;
    `);
    console.log('✅ Migration complete: collection_id removed');
  }
} catch(e) {
  console.error('❌ Migration failed:', e.message);
}

// Migration: move card_purchases manual prices to cards.paid
try {
  const manualPurchases = db.prepare(
    "SELECT card_id, SUM(price * quantity) as total FROM card_purchases WHERE purchase_id IS NULL GROUP BY card_id"
  ).all();
  for (const mp of manualPurchases) {
    db.prepare('UPDATE cards SET paid = ? WHERE id = ? AND paid = 0').run(mp.total, mp.card_id);
  }
} catch(e) {}

// ============ SETS ============
let _setsCache = null, _setsCacheTime = 0;

app.get(`${BASE_PATH}/api/sets`, async (req, res) => {
  try {
    if (_setsCache && Date.now() - _setsCacheTime < 3600000) return res.json(_setsCache);
    const r = await fetch(`${TCGDEX_API}/sets`);
    _setsCache = await r.json();
    _setsCacheTime = Date.now();
    res.json(_setsCache);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch sets' }); }
});

app.get(`${BASE_PATH}/api/sets/:id/cards`, async (req, res) => {
  try {
    const r = await fetch(`${TCGDEX_API}/sets/${req.params.id}`);
    if (!r.ok) return res.status(404).json({ error: 'Set not found' });
    const sd = await r.json();
    if (!sd?.cards) return res.json({ results: [], total: 0 });
    const serieId = sd.serie?.id || '';
    const results = sd.cards.map(c => ({
      card_id: c.id || '',
      name: c.name || 'Unknown',
      number: c.localId || '',
      set_id: sd.id || '',
      set_name: sd.name || '',
      image_small: serieId
        ? `https://assets.tcgdex.net/en/${serieId}/${sd.id}/${c.localId}/low.webp`
        : (c.image ? `${c.image}/low.webp` : ''),
      image_large: serieId
        ? `https://assets.tcgdex.net/en/${serieId}/${sd.id}/${c.localId}/high.webp`
        : (c.image ? `${c.image}/high.webp` : ''),
      rarity: '',
      types: [],
    }));
    res.json({ results, total: results.length, set: { id: sd.id, name: sd.name, cardCount: sd.cardCount } });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch set cards' }); }
});

// ============ SEARCH ============
app.get(`${BASE_PATH}/api/search`, async (req, res) => {
  try {
    const { q, set } = req.query;
    if (!q) return res.status(400).json({ error: 'Query "q" required' });

    let results = [];
    const slashMatch = q.match(/^(\d+)\s*\/\s*(\d+)$/);

    if (slashMatch) {
      const [, number, totalStr] = slashMatch;
      const total = parseInt(totalStr);
      const setsRes = await fetch(`${TCGDEX_API}/sets`);
      const allSets = await setsRes.json();
      const matching = allSets.filter(s => (s.cardCount?.official||0) === total || (s.cardCount?.total||0) === total);
      const cards = await Promise.all(matching.map(async s => {
        try {
          let r = await fetch(`${TCGDEX_API}/cards/${s.id}-${number}`);
          if (r.ok) return await r.json();
          r = await fetch(`${TCGDEX_API}/cards/${s.id}-${String(number).padStart(3,'0')}`);
          if (r.ok) return await r.json();
        } catch {}
        return null;
      }));
      results = cards.filter(c => c?.name).map(formatCard);
    } else if (set) {
      const r = await fetch(`${TCGDEX_API}/sets/${set}`);
      const sd = await r.json();
      if (sd?.cards) {
        const filtered = sd.cards.filter(c => c.localId === q || c.name?.toLowerCase().includes(q.toLowerCase()));
        const detailed = await Promise.all(filtered.slice(0,20).map(async c => {
          try { return await (await fetch(`${TCGDEX_API}/cards/${c.id}`)).json(); } catch { return null; }
        }));
        results = detailed.filter(Boolean).map(formatCard);
      }
    } else {
      const r = await fetch(`${TCGDEX_API}/cards?name=${encodeURIComponent(q)}`);
      const cards = await r.json();
      if (Array.isArray(cards)) {
        const detailed = await Promise.all(cards.slice(0,20).map(async c => {
          try { return await (await fetch(`${TCGDEX_API}/cards/${c.id}`)).json(); } catch { return null; }
        }));
        results = detailed.filter(Boolean).map(formatCard);
      }
    }
    res.json({ results, total: results.length });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

function formatCard(c) {
  const setTotal = c.set?.cardCount?.official || c.set?.cardCount?.total || '?';
  return {
    card_id: c.id || '', name: c.name || 'Unknown', number: c.localId || '',
    set_id: c.set?.id || '', set_name: c.set?.name || '', set_total: setTotal,
    set_logo: c.set?.logo ? c.set.logo + '.webp' : '',
    set_symbol: c.set?.symbol ? c.set.symbol + '.webp' : '',
    rarity: c.rarity || 'Unknown', types: (c.types || []).join(', '),
    hp: c.hp || '', stage: c.stage || '', category: c.category || '',
    illustrator: c.illustrator || '', attacks: c.attacks || [],
    retreat: c.retreat || 0, weaknesses: c.weaknesses || [],
    resistances: c.resistances || [], regulationMark: c.regulationMark || '',
    legal: c.legal || {}, dexId: c.dexId || [],
    variants: c.variants || {}, pricing: c.pricing || {},
    image_small: c.image ? c.image + '/low.webp' : '',
    image_large: c.image ? c.image + '/high.webp' : '',
  };
}

// ============ TAGS CRUD ============
app.get(`${BASE_PATH}/api/tags`, (req, res) => {
  const tags = db.prepare(`
    SELECT t.*, COUNT(ct.card_id) as card_count
    FROM tags t LEFT JOIN card_tags ct ON ct.tag_id = t.id
    GROUP BY t.id ORDER BY t.name ASC
  `).all();
  res.json(tags);
});

app.post(`${BASE_PATH}/api/tags`, (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const r = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name.trim(), color || '#ff4757');
    res.json({ id: r.lastInsertRowid, name: name.trim(), color: color || '#ff4757' });
  } catch(e) { res.status(400).json({ error: 'Tag already exists' }); }
});

app.patch(`${BASE_PATH}/api/tags/:id`, (req, res) => {
  const { name, color } = req.body;
  if (name) db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  if (color) db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(color, req.params.id);
  const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
  res.json(tag);
});

app.delete(`${BASE_PATH}/api/tags/:id`, (req, res) => {
  db.prepare('DELETE FROM card_tags WHERE tag_id = ?').run(req.params.id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============ CARDS ============
app.get(`${BASE_PATH}/api/cards`, (req, res) => {
  const { search, sort, set_id, artist, type, rarity, tag_id, wishlist, language, limit = 60, offset = 0 } = req.query;
  let query = `SELECT c.*,
    GROUP_CONCAT(ct.tag_id) as tag_ids,
    COALESCE(SUM(cp.price * cp.quantity), 0) as total_paid
    FROM cards c
    LEFT JOIN card_tags ct ON ct.card_id = c.id
    LEFT JOIN card_purchases cp ON cp.card_id = c.id`;
  const wheres = [];
  const params = [];

  if (tag_id) {
    wheres.push('c.id IN (SELECT card_id FROM card_tags WHERE tag_id = ?)');
    params.push(tag_id);
  }
  if (search) {
    wheres.push('(c.name LIKE ? OR c.set_name LIKE ? OR c.number LIKE ? OR c.types LIKE ?)');
    const s = `%${search}%`; params.push(s,s,s,s);
  }
  if (set_id) { wheres.push('c.set_id = ?'); params.push(set_id); }
  if (artist) { wheres.push("json_extract(c.full_data, '$.illustrator') = ?"); params.push(artist); }
  if (type) { wheres.push('c.types LIKE ?'); params.push(`%${type}%`); }
  if (rarity) { wheres.push('c.rarity = ?'); params.push(rarity); }
  if (language) { wheres.push('c.language = ?'); params.push(language); }
  if (wishlist === '1') { wheres.push('c.wishlist = 1'); }
  else if (wishlist === '0') { wheres.push('c.wishlist = 0'); }

  if (wheres.length) query += ' WHERE ' + wheres.join(' AND ');
  query += ' GROUP BY c.id';

  const sortMap = { name:'c.name ASC', number:'CAST(c.number AS INTEGER) ASC',
    set:'c.set_name ASC, CAST(c.number AS INTEGER) ASC', rarity:'c.rarity ASC', added:'c.added_at DESC',
    value:'total_paid DESC' };
  query += ` ORDER BY ${sortMap[sort] || sortMap.added}`;

  const countQuery = `SELECT COUNT(DISTINCT c.id) as t FROM cards c LEFT JOIN card_tags ct ON ct.card_id = c.id LEFT JOIN card_purchases cp ON cp.card_id = c.id${wheres.length ? ' WHERE ' + wheres.join(' AND ') : ''}`;
  const total = db.prepare(countQuery).get(...params).t;

  query += ` LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), parseInt(offset));

  const cards = db.prepare(query).all(...params).map(card => {
    try { card.full_data = JSON.parse(card.full_data || '{}'); } catch { card.full_data = {}; }
    card.tag_ids = card.tag_ids ? card.tag_ids.split(',').map(Number) : [];
    return card;
  });
  res.json({ cards, total });
});

app.post(`${BASE_PATH}/api/cards`, (req, res) => {
  try {
    const { card_id, name, number, set_id, set_name, rarity, image_small, image_large, quantity, purchase_id, price, wishlist } = req.body;
    const types = Array.isArray(req.body.types) ? req.body.types.join(', ') : (req.body.types || '');
    if (!card_id) return res.status(400).json({ error: 'card_id obrigatório' });
    const fullData = JSON.stringify(req.body);
    const isWishlist = wishlist ? 1 : 0;

    const existing = db.prepare('SELECT * FROM cards WHERE card_id = ?').get(card_id);
    let cardDbId;

    if (existing) {
      db.prepare('UPDATE cards SET quantity = quantity + ?, full_data = ? WHERE id = ?').run(quantity||1, fullData, existing.id);
      cardDbId = existing.id;
    } else {
      const r = db.prepare(`INSERT INTO cards (card_id, name, number, set_id, set_name, rarity, types, image_small, image_large, full_data, quantity, wishlist)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(card_id, name, number, set_id, set_name, rarity||'', types||'', image_small||'', image_large||'', fullData, quantity||1, isWishlist);
      cardDbId = r.lastInsertRowid;
    }

    // Adiciona entrada de compra se fornecido (só quando price foi explicitamente enviado e não é null)
    if (price != null || purchase_id) {
      let finalPrice = parseFloat(price) || 0;
      let priceMode = 'manual';

      if (purchase_id) {
        const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id);
        const cardsInPurchase = db.prepare('SELECT COALESCE(SUM(quantity),0) as t FROM card_purchases WHERE purchase_id = ?').get(purchase_id).t;
        finalPrice = purchase.price / (cardsInPurchase + (quantity || 1));
        priceMode = 'auto';
      }

      db.prepare(`
        INSERT INTO card_purchases (card_id, purchase_id, price, price_mode, quantity)
        VALUES (?, ?, ?, ?, ?)
      `).run(cardDbId, purchase_id || null, finalPrice, priceMode, quantity || 1);
    }

    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardDbId);
    try { updated.full_data = JSON.parse(updated.full_data); } catch {}
    res.json(updated);
  } catch(e) {
    console.error('POST /api/cards error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch(`${BASE_PATH}/api/cards/:id`, (req, res) => {
  const { quantity, language, value, paid, wishlist } = req.body;
  if (quantity !== undefined && quantity <= 0) { db.prepare('DELETE FROM card_tags WHERE card_id = ?').run(req.params.id); db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id); return res.json({ deleted: true }); }
  if (quantity !== undefined) db.prepare('UPDATE cards SET quantity = ? WHERE id = ?').run(quantity, req.params.id);
  if (language) db.prepare('UPDATE cards SET language = ? WHERE id = ?').run(language, req.params.id);
  if (value !== undefined) db.prepare('UPDATE cards SET value = ? WHERE id = ?').run(parseFloat(value) || 0, req.params.id);
  if (paid !== undefined) db.prepare('UPDATE cards SET paid = ? WHERE id = ?').run(parseFloat(paid) || 0, req.params.id);
  if (wishlist !== undefined) db.prepare('UPDATE cards SET wishlist = ? WHERE id = ?').run(wishlist ? 1 : 0, req.params.id);
  res.json(db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id));
});

app.delete(`${BASE_PATH}/api/cards/:id`, (req, res) => {
  db.prepare('DELETE FROM card_tags WHERE card_id = ?').run(req.params.id);
  db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============ CARD <-> TAG ============
app.post(`${BASE_PATH}/api/cards/:id/tags`, (req, res) => {
  const { tag_id } = req.body;
  try { db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(req.params.id, tag_id); } catch {}
  const tags = db.prepare('SELECT t.* FROM tags t JOIN card_tags ct ON ct.tag_id = t.id WHERE ct.card_id = ?').all(req.params.id);
  res.json(tags);
});

app.delete(`${BASE_PATH}/api/cards/:id/tags/:tagId`, (req, res) => {
  db.prepare('DELETE FROM card_tags WHERE card_id = ? AND tag_id = ?').run(req.params.id, req.params.tagId);
  const tags = db.prepare('SELECT t.* FROM tags t JOIN card_tags ct ON ct.tag_id = t.id WHERE ct.card_id = ?').all(req.params.id);
  res.json(tags);
});

app.get(`${BASE_PATH}/api/cards/:id/tags`, (req, res) => {
  const tags = db.prepare('SELECT t.* FROM tags t JOIN card_tags ct ON ct.tag_id = t.id WHERE ct.card_id = ?').all(req.params.id);
  res.json(tags);
});

// ============ FILTERS ============
app.get(`${BASE_PATH}/api/filters`, (req, res) => {
  const sets = db.prepare(`SELECT DISTINCT set_id, set_name,
    json_extract(full_data, '$.set_logo') as set_logo,
    json_extract(full_data, '$.set_total') as set_total,
    COUNT(*) as card_count, COALESCE(SUM(quantity),0) as total_cards
    FROM cards WHERE set_name != '' GROUP BY set_id ORDER BY set_name ASC`).all();
  const artists = db.prepare(`SELECT DISTINCT json_extract(full_data, '$.illustrator') as illustrator, COUNT(*) as card_count
    FROM cards WHERE json_extract(full_data, '$.illustrator') IS NOT NULL AND json_extract(full_data, '$.illustrator') != ''
    GROUP BY illustrator ORDER BY illustrator ASC`).all();
  const types = db.prepare(`SELECT DISTINCT types, COUNT(*) as card_count FROM cards WHERE types != '' GROUP BY types ORDER BY card_count DESC`).all();
  const rarities = db.prepare(`SELECT DISTINCT rarity, COUNT(*) as card_count FROM cards WHERE rarity != '' AND rarity != 'Unknown' GROUP BY rarity ORDER BY card_count DESC`).all();
  res.json({ sets, artists, types, rarities });
});

// ============ STATS ============
app.get(`${BASE_PATH}/api/stats`, (req, res) => {
  const collectionPaid = db.prepare(
    'SELECT COALESCE(SUM(paid),0) as t FROM cards WHERE wishlist = 0'
  ).get().t;

  const collectionValue = db.prepare(
    'SELECT COALESCE(SUM(value * quantity),0) as t FROM cards WHERE wishlist = 0'
  ).get().t;

  const boosterSpent = db.prepare('SELECT COALESCE(SUM(price),0) as t FROM purchases').get().t;

  const boosterCardsValue = db.prepare(
    `SELECT COALESCE(SUM(c.value * cp.quantity),0) as t
     FROM card_purchases cp
     JOIN cards c ON c.id = cp.card_id
     WHERE cp.purchase_id IS NOT NULL AND c.wishlist = 0`
  ).get().t;

  const boosterProfit = boosterCardsValue - boosterSpent;

  res.json({
    totalCards: db.prepare('SELECT COALESCE(SUM(quantity),0) as t FROM cards WHERE wishlist = 0').get().t,
    uniqueCards: db.prepare('SELECT COUNT(*) as t FROM cards WHERE wishlist = 0').get().t,
    sets: db.prepare('SELECT COUNT(DISTINCT set_name) as t FROM cards WHERE wishlist = 0').get().t,
    tags: db.prepare('SELECT COUNT(*) as t FROM tags').get().t,
    wishlistCount: db.prepare('SELECT COUNT(*) as t FROM cards WHERE wishlist = 1').get().t,
    collectionPaid,
    collectionValue,
    boosterSpent,
    boosterCardsValue,
    boosterProfit,
  });
});

// ============ PURCHASES ============
app.get(`${BASE_PATH}/api/purchases`, (req, res) => {
  const purchases = db.prepare(`
    SELECT p.*, 
      COUNT(DISTINCT cp.card_id) as card_count,
      COALESCE(SUM(cp.quantity),0) as total_cards
    FROM purchases p 
    LEFT JOIN card_purchases cp ON cp.purchase_id = p.id
    GROUP BY p.id 
    ORDER BY p.date DESC
  `).all();
  res.json(purchases);
});

app.post(`${BASE_PATH}/api/purchases`, (req, res) => {
  const { name, type, price, date, notes } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'Name and price required' });
  
  const r = db.prepare('INSERT INTO purchases (name, type, price, date, notes) VALUES (?, ?, ?, ?, ?)').run(
    name.trim(), 
    type || 'booster', 
    parseFloat(price) || 0,
    date || new Date().toISOString(),
    notes || ''
  );
  res.json({ id: r.lastInsertRowid, name, type, price, date, notes });
});

app.patch(`${BASE_PATH}/api/purchases/:id`, (req, res) => {
  const { name, type, price, date, notes } = req.body;
  if (name) db.prepare('UPDATE purchases SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  if (type) db.prepare('UPDATE purchases SET type = ? WHERE id = ?').run(type, req.params.id);
  if (price !== undefined) db.prepare('UPDATE purchases SET price = ? WHERE id = ?').run(parseFloat(price), req.params.id);
  if (date) db.prepare('UPDATE purchases SET date = ? WHERE id = ?').run(date, req.params.id);
  if (notes !== undefined) db.prepare('UPDATE purchases SET notes = ? WHERE id = ?').run(notes, req.params.id);
  
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.id);
  res.json(purchase);
});

app.delete(`${BASE_PATH}/api/purchases/:id`, (req, res) => {
  db.prepare('DELETE FROM card_purchases WHERE purchase_id = ?').run(req.params.id);
  db.prepare('DELETE FROM purchases WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============ CARD PURCHASES ============
app.post(`${BASE_PATH}/api/cards/:id/purchase`, (req, res) => {
  const { purchase_id, price, quantity } = req.body;
  const cardId = req.params.id;
  
  // Se tem purchase_id, divide o preço do booster
  let finalPrice = parseFloat(price) || 0;
  let priceMode = 'manual';
  
  if (purchase_id) {
    const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id);
    const cardsInPurchase = db.prepare('SELECT COALESCE(SUM(quantity),0) as t FROM card_purchases WHERE purchase_id = ?').get(purchase_id).t;
    finalPrice = purchase.price / (cardsInPurchase + (quantity || 1));
    priceMode = 'auto';
  }
  
  const r = db.prepare(`
    INSERT INTO card_purchases (card_id, purchase_id, price, price_mode, quantity)
    VALUES (?, ?, ?, ?, ?)
  `).run(cardId, purchase_id || null, finalPrice, priceMode, quantity || 1);
  
  res.json({ id: r.lastInsertRowid, card_id: cardId, purchase_id, price: finalPrice, price_mode: priceMode, quantity });
});

app.get(`${BASE_PATH}/api/cards/:id/purchases`, (req, res) => {
  const rows = db.prepare(`
    SELECT cp.*, p.name as purchase_name, p.type as purchase_type, p.date as purchase_date, p.price as purchase_price
    FROM card_purchases cp
    LEFT JOIN purchases p ON p.id = cp.purchase_id
    WHERE cp.card_id = ?
    ORDER BY cp.added_at DESC
  `).all(req.params.id);

  // Recalculate avg price dynamically for booster-linked purchases
  const result = rows.map(row => {
    if (row.purchase_id && row.purchase_price) {
      const totalCards = db.prepare(
        'SELECT COALESCE(SUM(quantity),0) as t FROM card_purchases WHERE purchase_id = ?'
      ).get(row.purchase_id).t;
      row.price = totalCards > 0 ? row.purchase_price / totalCards : 0;
    }
    return row;
  });

  res.json(result);
});

// ============ PURCHASE DETAILS (cards linked) ============
app.get(`${BASE_PATH}/api/purchases/:id/cards`, (req, res) => {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.id);
  if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

  const linkedCards = db.prepare(`
    SELECT c.id, c.name, c.number, c.set_name, c.image_small, c.rarity, c.value,
           cp.quantity as cp_quantity
    FROM card_purchases cp
    JOIN cards c ON c.id = cp.card_id
    WHERE cp.purchase_id = ?
    ORDER BY c.name ASC
  `).all(req.params.id);

  const totalLinkedCards = linkedCards.reduce((sum, c) => sum + (c.cp_quantity || 1), 0);
  const avgPrice = totalLinkedCards > 0 ? purchase.price / totalLinkedCards : 0;

  res.json({
    purchase,
    cards: linkedCards,
    totalLinkedCards,
    avgPrice
  });
});

// ============ EDIT/DELETE CARD PURCHASE ============
app.patch(`${BASE_PATH}/api/card-purchases/:id`, (req, res) => {
  const { price } = req.body;
  if (price === undefined) return res.status(400).json({ error: 'Price required' });
  db.prepare('UPDATE card_purchases SET price = ?, price_mode = ? WHERE id = ?').run(parseFloat(price), 'manual', req.params.id);
  const cp = db.prepare('SELECT * FROM card_purchases WHERE id = ?').get(req.params.id);
  res.json(cp);
});

app.delete(`${BASE_PATH}/api/card-purchases/:id`, (req, res) => {
  db.prepare('DELETE FROM card_purchases WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Serve frontend
app.get(`${BASE_PATH}`, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(`${BASE_PATH}`, express.static(path.join(__dirname, 'public')));
app.listen(PORT, '127.0.0.1', () => console.log(`🎴 Pokémon Card Catalog on http://127.0.0.1:${PORT}${BASE_PATH}`));
