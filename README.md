# Pokémon Card Collector

Aplicação local para gerenciar sua coleção de cartas Pokémon TCG.

## Requisitos

- [Node.js](https://nodejs.org/) v18+

## Instalação e uso

```bash
npm install
node server.js
```

Acesse: **http://127.0.0.1:3003/pokemon**

---

## Banco de dados

SQLite local (`pokemon.db`), criado automaticamente na primeira execução.

### Tabelas

| Tabela | Descrição |
|--------|-----------|
| `cards` | Cartas da coleção |
| `tags` | Tags para organização |
| `card_tags` | Relação carta ↔ tag |
| `purchases` | Registros de compras (boosters, bundles) |
| `card_purchases` | Relação carta ↔ compra |

---

## API REST

Base path: `/pokemon/api`

### Busca de cartas (TCGDex)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/search?q={query}` | Busca cartas pelo nome |
| GET | `/search?q={n}/{total}` | Busca pelo número `N/TOTAL` do set |
| GET | `/search?q={query}&set={set_id}` | Busca dentro de um set específico |

---

### Coleção — Cards

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/cards` | Lista todas as cartas |
| POST | `/cards` | Adiciona carta à coleção |
| PATCH | `/cards/:id` | Atualiza quantidade, idioma, valor ou preço pago |
| DELETE | `/cards/:id` | Remove carta da coleção |

**GET `/cards` — query params:**

| Param | Tipo | Descrição |
|-------|------|-----------|
| `search` | string | Filtra por nome, set, número ou tipo |
| `set_id` | string | Filtra por set |
| `artist` | string | Filtra por ilustrador |
| `type` | string | Filtra por tipo (ex: `Fire`) |
| `rarity` | string | Filtra por raridade |
| `tag_id` | number | Filtra por tag |
| `sort` | string | Ordenação: `name`, `number`, `set`, `rarity`, `added`, `value` |

**POST `/cards` — body:**

```json
{
  "card_id": "swsh1-1",
  "name": "Bulbasaur",
  "number": "1",
  "set_id": "swsh1",
  "set_name": "Sword & Shield",
  "rarity": "Common",
  "types": "Grass",
  "image_small": "https://...",
  "image_large": "https://...",
  "quantity": 1,
  "purchase_id": null,
  "price": 5.00
}
```

**PATCH `/cards/:id` — body (campos opcionais):**

```json
{
  "quantity": 2,
  "language": "pt",
  "value": 15.00,
  "paid": 8.00
}
```

> Enviar `quantity: 0` remove a carta automaticamente.

---

### Tags

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/tags` | Lista todas as tags |
| POST | `/tags` | Cria nova tag |
| PATCH | `/tags/:id` | Atualiza nome/cor |
| DELETE | `/tags/:id` | Remove tag |

**POST/PATCH `/tags` — body:**

```json
{
  "name": "Favoritas",
  "color": "#ff4757"
}
```

### Tags de uma carta

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/cards/:id/tags` | Lista tags da carta |
| POST | `/cards/:id/tags` | Adiciona tag à carta |
| DELETE | `/cards/:id/tags/:tagId` | Remove tag da carta |

---

### Compras (Boosters / Bundles)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/purchases` | Lista compras |
| POST | `/purchases` | Registra nova compra |
| PATCH | `/purchases/:id` | Atualiza compra |
| DELETE | `/purchases/:id` | Remove compra e vínculos |
| GET | `/purchases/:id/cards` | Cartas vinculadas a uma compra |

**POST `/purchases` — body:**

```json
{
  "name": "Booster Scarlet & Violet",
  "type": "booster",
  "price": 19.90,
  "date": "2025-01-01T00:00:00.000Z",
  "notes": "Comprado na loja X"
}
```

Tipos aceitos para `type`: `booster`, `bundle`, ou qualquer string.

### Compras de uma carta

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/cards/:id/purchases` | Histórico de compras da carta |
| POST | `/cards/:id/purchase` | Vincula carta a uma compra |
| PATCH | `/card-purchases/:id` | Atualiza preço de um vínculo |
| DELETE | `/card-purchases/:id` | Remove vínculo |

**POST `/cards/:id/purchase` — body:**

```json
{
  "purchase_id": 3,
  "price": 0,
  "quantity": 1
}
```

> Se `purchase_id` for informado, o preço por carta é calculado automaticamente dividindo o valor total do booster pela quantidade de cartas vinculadas.

---

### Filtros

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/filters` | Retorna sets, artistas, tipos e raridades da coleção |

Resposta:
```json
{
  "sets": [{ "set_id": "swsh1", "set_name": "Sword & Shield", "card_count": 10 }],
  "artists": [{ "illustrator": "Mitsuhiro Arita", "card_count": 3 }],
  "types": [{ "types": "Fire", "card_count": 5 }],
  "rarities": [{ "rarity": "Common", "card_count": 20 }]
}
```

---

### Estatísticas

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/stats` | Resumo geral da coleção |

Resposta:
```json
{
  "totalCards": 150,
  "uniqueCards": 120,
  "sets": 8,
  "tags": 5,
  "collectionPaid": 320.00,
  "collectionValue": 450.00,
  "boosterSpent": 200.00,
  "boosterCardsValue": 280.00,
  "boosterProfit": 80.00
}
```

| Campo | Descrição |
|-------|-----------|
| `totalCards` | Total de cartas (somando quantidades) |
| `uniqueCards` | Cartas únicas na coleção |
| `collectionPaid` | Total pago pelas cartas |
| `collectionValue` | Valor de mercado estimado |
| `boosterSpent` | Total investido em boosters/bundles |
| `boosterCardsValue` | Valor de mercado das cartas de boosters |
| `boosterProfit` | Lucro/prejuízo em boosters |

---

## Estrutura do projeto

```
pokemon-collector/
├── server.js        # Backend Express + SQLite
├── package.json
├── pokemon.db       # Banco de dados (gerado automaticamente)
└── public/
    └── index.html   # Frontend
```

## Fonte de dados

As buscas de cartas usam a [TCGDex API](https://tcgdex.net) (gratuita, sem autenticação).
