# Lambda

Lambda is a small, self-hosted notes and script library designed to run as a Home Assistant add-on. Notes are assembled from text, heading, code, image, and file-attachment blocks. They autosave continuously and are organised with one-level categories and tags.

## Highlights

- Single-user password authentication with rate limiting and secure, HTTP-only cookies that expire after 30 days of inactivity by default
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

## Home Assistant add-on

Copy this directory into the Home Assistant local add-ons folder as a folder named `lambda`, reload the add-on store, then install **Lambda**. Before starting it, replace the default password in the Configuration tab.

The SQLite database is written to `/config/snippet.db` inside the container and attachments are stored beside it in `/config/attachments`. The `addon_config` mapping exposes that as the add-on's own directory under Home Assistant's `addon_configs` storage. Both are included with add-on backups.

The add-on supports Home Assistant Ingress and also publishes port `8099` for a separate reverse proxy. Keep TLS termination at the proxy and forward `X-Forwarded-Proto`; Lambda will add the `Secure` flag to its session cookie when that header is `https`.

## Backups

For a consistent manual backup, stop the add-on and copy `snippet.db` together with the `attachments` folder. Home Assistant add-on backups include the mapped add-on configuration directory. SQLite WAL files may be present while the app is running.

## Version behavior

A snapshot is captured before the first change in an editing session. Long-running sessions rotate to a new snapshot window after five minutes. Restoring a version first snapshots the current note, and only the newest 20 snapshots are retained.
