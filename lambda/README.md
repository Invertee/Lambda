# Lambda

Lambda is a small, self-hosted notes and script library designed to run as a Home Assistant add-on. Notes are assembled from text, heading, code, image, and file-attachment blocks. They autosave continuously and are organised with one-level categories and tags.

## Highlights

- Single-user password authentication with rate limiting and secure, HTTP-only cookies that expire after 30 days of inactivity by default
- AES-256-GCM encryption at rest for note titles, block content, version content, and attachments
- Text, heading, code, compressed image, and disk-backed file-attachment blocks
- Drag, button-based reorder, remove, and one-click code copying or downloading
- A language picker for code blocks, defaulting to PowerShell
- Search across titles, content, languages, categories, and tags
- A browsable table for all notes, category views, tag views, and search results
- Recycle bin plus a rolling 20-snapshot version history per note
- REST and MCP automation interfaces protected by a separate static API key
- Installable PWA with an IndexedDB snapshot for offline, read-only viewing
- SQLite WAL database with no runtime npm dependencies
- Responsive desktop and mobile layouts

## Run locally

Node.js 22.13 or newer is required because Lambda uses Node's built-in SQLite driver.

```sh
$env:APP_PASSWORD="choose-a-password"
npm start
```

Open `http://localhost:8099`. The local database is created at `data/snippet.db`, with uploaded files in `data/attachments`. Optional environment variables are `PORT`, `HOST`, `DB_PATH`, `ATTACHMENTS_PATH`, `COOKIE_SECURE`, `SESSION_DAYS`, and `API_KEY`.

## Encryption at rest

Lambda creates a random 256-bit data-encryption key on first start. That key is wrapped with a key derived from the configured app password using scrypt and stored beside the database as `snippet.db.encryption.json`. Note titles, note blocks, version titles, version blocks, and attachment file contents are encrypted with AES-256-GCM before being written to disk. Each encrypted value uses a fresh nonce and authenticated associated data tied to its record.

Categories, tags, record IDs, timestamps, session metadata, and other structural database information remain plaintext so filtering, indexing, and automation continue to work normally. REST, MCP, and PowerShell/API clients receive decrypted data from the running Lambda service and require no encryption changes.

The encryption metadata file contains the salt and wrapped data key, not the plaintext key. Keep `snippet.db`, `snippet.db.encryption.json`, and the `attachments` directory together when backing up the app. The configured app password is required to unwrap the data key after restart; changing or losing that password without first rewrapping the key will make the encrypted data inaccessible.

The browser's IndexedDB offline snapshot and manually exported Lambda JSON backups remain plaintext on the device where they are created.

## Automation API

Set `API_KEY` (or `api_key` in the Home Assistant add-on configuration) to a long, random secret. Automation can then use either `Authorization: Bearer <key>` or `X-API-Key: <key>`; browser sessions continue to use the login cookie. Keep the endpoint behind HTTPS because the key grants write access.

The main REST operations are:

- `GET /api/notes?q=&category=&tag=&trash=1` — list or filter notes
- `POST /api/notes` — create a complete structured note
- `GET /api/notes/:id` — retrieve one note
- `PATCH /api/notes/:id` — update only the supplied `title`, `category`, `tags`, or `blocks`
- `PUT /api/notes/:id` — replace a complete note
- `DELETE /api/notes/:id` — move a note to the recycle bin
- `GET|POST /api/categories`, `PATCH|DELETE /api/categories/:id` — manage categories

A note payload uses an ordered block list:

```json
{
  "title": "Restart the print spooler",
  "category": "PowerShell",
  "tags": ["windows", "services"],
  "blocks": [
    { "type": "code", "language": "powershell", "content": "Restart-Service Spooler" }
  ]
}
```

### PowerShell helper

Dot-source the bundled helper, set the endpoint and key once, then pipe or pass content into `New-LambdaNote`:

```powershell
. ./tools/Lambda.ps1
$env:LAMBDA_URL = 'https://notes.example.com'
$env:LAMBDA_API_KEY = 'replace-with-your-random-key'

New-LambdaNote -Title 'Restart service' -Category 'PowerShell' `
  -Tags admin,windows -BlockType code -Language powershell `
  -Content 'Restart-Service Spooler'
```

## MCP endpoint

The stateless Streamable HTTP endpoint is `POST /mcp`. Configure an MCP client with that URL and an `Authorization: Bearer <key>` header. The server supports the current `2026-07-28` protocol and the legacy initialize flow used by `2025-11-25`, `2025-06-18`, and `2025-03-26` clients.

Its tools are `list_notes`, `get_note`, `create_note`, `update_note`, `delete_note`, `restore_note`, `list_categories`, `create_category`, `rename_category`, and `delete_category`. Deletes are recoverable: the MCP interface deliberately moves notes to the recycle bin and does not expose permanent deletion.

## Home Assistant app

Add `https://github.com/Invertee/Lambda` as a repository in the Home Assistant app store, then install **Lambda**. Before starting it, set a password in the Configuration tab.

The SQLite database is written to `/config/snippet.db` inside the container and attachments are stored beside it in `/config/attachments`. The wrapped encryption key metadata is written to `/config/snippet.db.encryption.json`. The `addon_config` mapping exposes that directory under Home Assistant's `addon_configs` storage, so all three are included with app backups.

The app supports Home Assistant Ingress and also publishes port `8099` for a separate reverse proxy. Keep TLS termination at the proxy and forward `X-Forwarded-Proto`; Lambda will add the `Secure` flag to its session cookie when that header is `https`.

## Backups

For a consistent manual backup, stop the app and copy `snippet.db`, `snippet.db.encryption.json`, and the `attachments` folder together. Home Assistant app backups include the mapped app configuration directory. SQLite WAL files may be present while the app is running.

## Version behavior

A snapshot is captured before the first change in an editing session. Long-running sessions rotate to a new snapshot window after five minutes. Restoring a version first snapshots the current note, and only the newest 20 snapshots are retained.
