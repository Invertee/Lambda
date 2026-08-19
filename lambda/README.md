# Lambda

Lambda is a small, self-hosted notes and script library designed to run as a Home Assistant add-on. Notes are assembled from text, code, CSV table, image, and file-attachment blocks. They autosave continuously and are organised with one-level categories and tags.

## Highlights

- Single-user password authentication with rate limiting and secure, HTTP-only cookies that expire after 30 days of inactivity by default
- AES-256-GCM encryption at rest for note titles, block content, version content, and attachments
- Stable five-character alphanumeric codes on every block for direct REST, MCP, and script access
- Text, code, editable CSV table, compressed image, and disk-backed file-attachment blocks
- CSV tables can be edited in the web interface and downloaded as standard `.csv` files
- Drag, button-based reorder, remove, and one-click code copying or downloading
- A language picker for code blocks, defaulting to PowerShell
- Search across titles, content, block codes, languages, categories, and tags
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

Categories, tags, record IDs, timestamps, block codes, session metadata, and other structural database information remain plaintext so filtering, indexing, and automation continue to work normally. REST, MCP, and PowerShell/API clients receive decrypted data from the running Lambda service and require no encryption changes.

The encryption metadata file contains the salt and wrapped data key, not the plaintext key. Keep `snippet.db`, `snippet.db.encryption.json`, and the `attachments` directory together when backing up the app. The configured app password is required to unwrap the data key after restart; changing or losing that password without first rewrapping the key will make the encrypted data inaccessible.

The browser's IndexedDB offline snapshot and manually exported Lambda JSON backups remain plaintext on the device where they are created.

## Block codes

Every block receives a globally unique five-character uppercase alphanumeric code such as `A1B2C`. The code is assigned by the server, returned as the block's `code` property, displayed in the web editor, and can be copied with one click.

A code stays attached to the same block when its content changes or when the block is reordered. Codes are retained as tombstones when blocks are removed so they are not reassigned to a different block. Blocks inside notes in the recycle bin are unavailable through the block API; restoring the note reactivates the original codes.

This makes a block a stable automation target without requiring the note UUID or block UUID.

Legacy `heading` blocks from older Lambda versions are normalised to ordinary text blocks when loaded or validated, preserving their content while retiring the separate heading type.

## CSV table blocks

A `csv` block stores standard CSV text in its `content` field. In the web interface Lambda renders that content as an editable table with controls to add or remove rows and columns and download the current data as a CSV file. CSV content remains compatible with the normal REST and MCP interfaces, so scripts can write or retrieve it without any browser-specific format.

For example, a block may contain:

```csv
Name,Status
Spooler,Running
W32Time,Stopped
```

## Automation API

Set `API_KEY` (or `api_key` in the Home Assistant add-on configuration) to a long, random secret. Automation can then use either `Authorization: Bearer <key>` or `X-API-Key: <key>`; browser sessions continue to use the login cookie. Keep the endpoint behind HTTPS because the key grants write access.

The main REST operations are:

- `GET /api/notes?q=&category=&tag=&trash=1` — list or filter notes
- `POST /api/notes` — create a complete structured note
- `GET /api/notes/:id` — retrieve one note
- `PATCH /api/notes/:id` — update only the supplied `title`, `category`, `tags`, or `blocks`
- `PUT /api/notes/:id` — replace a complete note
- `DELETE /api/notes/:id` — move a note to the recycle bin
- `GET /api/blocks/:code` — retrieve one active block by its five-character code
- `PATCH|PUT /api/blocks/:code` — update a block by code using JSON
- `PUT /api/blocks/:code` with `Content-Type: text/csv` — replace a block with CSV data and make it a table block
- `GET|POST /api/categories`, `PATCH|DELETE /api/categories/:id` — manage categories

A note payload uses an ordered block list. Codes are server-assigned, so they can be omitted when creating new blocks:

```json
{
  "title": "Restart the print spooler",
  "category": "PowerShell",
  "tags": ["windows", "services"],
  "blocks": [
    { "type": "code", "language": "powershell", "content": "Restart-Service Spooler" },
    { "type": "csv", "content": "Name,Status\nSpooler,Running" }
  ]
}
```

A block lookup returns its note context and the complete block:

```json
{
  "code": "A1B2C",
  "noteId": "...",
  "noteTitle": "Service state",
  "block": {
    "id": "...",
    "code": "A1B2C",
    "type": "csv",
    "content": "Name,Status\nSpooler,Running"
  }
}
```

### PowerShell helper

The bundled `tools/Lambda.ps1` helper can be loaded from your PowerShell profile so the Lambda URL and API key do not need to be supplied on every command. Dot-source the helper once, then install its profile block:

```powershell
. .\tools\Lambda.ps1
Install-LambdaProfile -Uri 'https://notes.example.com' -ApiKey $api
```

`Install-LambdaProfile` adds the helper path and `Set-LambdaConnection` call to the current `$PROFILE`. The API key is therefore stored as plaintext in the PowerShell profile file. You can also skip the installer and continue to use `LAMBDA_URL` and `LAMBDA_API_KEY` environment variables.

The helper exposes the original commands plus shorter aliases:

- `New-Snip` → `New-LambdaNote`
- `Get-Snip` → `Get-LambdaBlock`
- `Set-Snip` → `Set-LambdaBlock`

`New-Snip` accepts `-Name` as an alias for `-Title` and defaults new notes to the `Snippets` category.

Structured PowerShell pipeline objects automatically become CSV table blocks. Arrays passed through `-Content` are expanded into their individual objects instead of being serialised as `System.Object[]` metadata. Where PowerShell exposes a default display property set, Lambda uses those display properties as the table columns; otherwise the object's readable properties are used.

For example:

```powershell
Get-NetAdapter | New-Snip -Name 'net adaptors'
```

No `-Category`, `-BlockType`, `-Uri`, or `-ApiKey` parameters are required after the profile has been configured. String pipelines remain normal text blocks unless a block type is explicitly supplied.

Create a code note explicitly:

```powershell
New-Snip -Name 'Restart service' -Category 'PowerShell' `
  -Tags admin,windows -BlockType code -Language powershell `
  -Content 'Restart-Service Spooler'
```

An array can also be passed directly:

```powershell
$adapters = Get-NetAdapter
New-Snip -Name 'net adaptors' -Content $adapters
```

Replace an existing block with structured command output. Structured objects automatically convert the target to a CSV table:

```powershell
Get-Process | Select-Object Name, Id, CPU | Set-Snip C3D4E
```

Replace an existing block with normal text:

```powershell
Get-Content .\latest-output.txt | Set-Snip A1B2C
```

Retrieve a block or convert a CSV block back into PowerShell objects:

```powershell
Get-Snip A1B2C
Get-Snip C3D4E -ContentOnly
Get-Snip C3D4E -AsTable
```

## MCP endpoint

The stateless Streamable HTTP endpoint is `POST /mcp`. Configure an MCP client with that URL and an `Authorization: Bearer <key>` header. The server supports the current `2026-07-28` protocol and the legacy initialize flow used by `2025-11-25`, `2025-06-18`, and `2025-03-26` clients.

Its tools are `list_notes`, `get_note`, `get_block`, `update_block`, `create_note`, `update_note`, `delete_note`, `restore_note`, `list_categories`, `create_category`, `rename_category`, and `delete_category`. `get_block` and `update_block` address a block directly with its five-character code; CSV data is passed as standard CSV text in `content`. Deletes are recoverable: the MCP interface deliberately moves notes to the recycle bin and does not expose permanent deletion.

## Home Assistant app

Add `https://github.com/Invertee/Lambda` as a repository in the Home Assistant app store, then install **Lambda**. Before starting it, set a password in the Configuration tab.

The SQLite database is written to `/config/snippet.db` inside the container and attachments are stored beside it in `/config/attachments`. The wrapped encryption key metadata is written to `/config/snippet.db.encryption.json`. The `addon_config` mapping exposes that directory under Home Assistant's `addon_configs` storage, so all three are included with app backups.

The app supports Home Assistant Ingress and also publishes port `8099` for a separate reverse proxy. Keep TLS termination at the proxy and forward `X-Forwarded-Proto`; Lambda will add the `Secure` flag to its session cookie when that header is `https`.

## Backups

For a consistent manual backup, stop the app and copy `snippet.db`, `snippet.db.encryption.json`, and the `attachments` folder together. Home Assistant app backups include the mapped app configuration directory. SQLite WAL files may be present while the app is running.

## Version behavior

A snapshot is captured before the first change in an editing session. Long-running sessions rotate to a new snapshot window after five minutes. Restoring a version first snapshots the current note, and only the newest 20 snapshots are retained.
