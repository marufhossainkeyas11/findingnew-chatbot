# FindingNew Menu Chatbot (Cloudflare Worker)

Stateless, zero-dependency Cloudflare Worker menu chatbot for **FindingNew** supporting both **WhatsApp Cloud API** and **Facebook Messenger** from a single codebase and `tree.json`.

## 1. Setup & D1 Database Initialization

1. Place your `tree.json` inside `src/tree.json`.
2. Create the Cloudflare D1 database:
   ```bash
   npx wrangler d1 create findingnew_db
