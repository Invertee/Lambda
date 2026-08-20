# Lambda

Lambda is a small, self-hosted notes, to-do, and script library designed to run as a Home Assistant add-on. Notes are assembled from text, code, CSV table, image, and file-attachment blocks, while To-Dos are kept in a separate task view with due dates, subtasks, and completion history.

## Highlights

- Single-user password authentication with rate limiting and secure, HTTP-only cookies that expire after 30 days of inactivity by default
- AES-256-GCM encryption at rest for note titles, block content, version content, attachment contents, To-Do titles, and To-Do subtasks
- Separate Microsoft To Do-style task tracking with active/completed piles, optional due dates, and subtasks
- Stable five-character alphanumeric codes on every note block for direct REST, MCP, and script access
- Text, code, editable CSV table, compressed image, and disk-backed file-attachment blocks
- CSV tables can be edited in the web interface and downloaded as standard `.csv` files
- Drag, button-based reorder, remove, and one-click code copying or downloading
- A language picker for code blocks, defaulting to PowerShell
- Search across titles, content, block codes, languages, categories, and tags
- A browsable table for all notes, category views, tag views, and search results
- Recycle bin plus a rolling 20-snapshot version history per note
- REST and MCP automation interfaces protected by a separate static API key
- PowerShell helpers for note blocks and To-Dos using one saved Lambda connection
- Installable PWA with an IndexedDB snapshot for offline, read-only note viewing
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

Lambda creates a random 256-bit data-encryption key on first start. That key is wrapped with a key derived from the configured app password using scrypt and stored beside the database as `snippet.db.encryption.json`. Note titles, note blocks, version titles, version blocks, To-Do titles, To-Do subtasks, and attachment file contents are encrypted with AES-256-GCM before being written to disk. Each encrypted value uses a fresh nonce and authenticated associated data tied to its record.

Categories, tags, record IDs, timestamps, block codes, To-Do due dates/completion timestamps, session metadata, and other structural database information remain plaintext so filtering, indexing, and automation continue to work normally. REST, MCP, and PowerShell/API clients receive decrypted data from the running Lambda service and require no encryption changes.

The encryption metadata file contains the salt and wrapped data key, not the plaintext key. Keep `snippet.db`, `snippet.db.encryption.json`, and the `attachments` directory together when backing up the app. The configured app password is required to unwrap the data key after restart; changing or losing that password without first rewrapping the key will make the encrypted data inaccessible.

The browser's IndexedDB offline snapshot and manually exported Lambda JSON backups remain plaintext on the device where they are created.

## To-Dos

To-Dos are separate from notes and appear above **All notes** in the sidebar. Active tasks are shown in the main To-Do list. Checking a task marks it complete, strikes it through, and moves it into the completed pile. Completed items can be reopened individually or cleared permanently as a group.

Each To-Do supports:

- a title
- an optional `YYYY-MM-DD` due date
- up to 100 subtasks/steps with independent completion state
- active/completed state and completion timestamp

The default REST, MCP, and PowerShell list operations return **active To-Dos only**. Completed history is queried only when explicitly requested, avoiding unnecessary decryption and payload size as the completed list grows.

## Block codes

Every note block receives a globally unique five-character uppercase alphanumeric code such as `A1B2C`. The code is assigned by the server, returned as the block's `code` property, displayed in the web editor, and can be copied with one click.

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

Set `API_KEY` (or `api_key` in the Home Assistant add-on configuration) to a long, random secret. Automation can then use either `Authorization: Bearer <key>` or the supported API-key header forms; browser sessions continue to use the login cookie. Keep the endpoint behind HTTPS because the key grants write access.

The main To-Do REST operations are:

- `GET /api/todos` — active To-Dos only
- `GET /api/todos?include_completed=1` — active and completed To-Dos
- `GET /api/todos?completed=1` — completed To-Dos only
- `GET /api/todos?q=search` — search active To-Dos and subtasks
- `POST /api/todos` — create a To-Do
- `GET /api/todos/:id` — retrieve one To-Do
- `PATCH /api/todos/:id` — partially update title, due date, subtasks, or completion state
- `PUT /api/todos/:id` — replace a To-Do payload
- `DELETE /api/todos/:id` — permanently delete one To-Do
- `DELETE /api/todos/completed` — permanently clear all completed To-Dos

Example:

```json
{
  "title": "Review tenant configuration",
  "dueDate": "2026-08-22",
  "subtasks": [
    { "title": "Export Conditional Access policies" },
    { "title": "Review exclusions" }
  ]
}
```

The main note REST operations are:

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

The note/block aliases are:

- `New-Snip` → `New-LambdaNote`
- `Get-Snip` → `Get-LambdaBlock`
- `Set-Snip` → `Set-LambdaBlock`

The To-Do aliases are:

- `New-Todo` → `New-LambdaTodo`
- `Get-Todo` → `Get-LambdaTodo`
- `Set-Todo` → `Set-LambdaTodo`
- `Complete-Todo` → `Complete-LambdaTodo`
- `Remove-Todo` → `Remove-LambdaTodo`
- `Clear-CompletedTodo` → `Clear-LambdaCompletedTodo`

Examples:

```powershell
New-Todo -Name 'Review tenant' -DueDate tomorrow `
  -Subtask 'Export configuration','Review exclusions'

Get-Todo
Get-Todo -IncludeCompleted
Get-Todo -CompletedOnly

Set-Todo $todoId -DueDate '2026-08-30'
Complete-Todo $todoId
Complete-Todo $todoId -Reopen
Remove-Todo $todoId
Clear-CompletedTodo
```

`Get-Todo` returns active tasks only unless `-IncludeCompleted` or `-CompletedOnly` is supplied.

`New-Snip` accepts `-Name` as an alias for `-Title` and defaults new notes to the `Snippets` category. Structured PowerShell pipeline objects automatically become CSV table blocks. Arrays passed through `-Content` are expanded into their individual objects instead of being serialised as `System.Object[]` metadata. Where PowerShell exposes a default display property set, Lambda uses those display properties as the table columns; otherwise the object's readable properties are used.

```powershell
Get-NetAdapter | New-Snip -Name 'net adaptors'

Get-Process | Select-Object Name, Id, CPU | Set-Snip C3D4E

Get-Snip A1B2C
Get-Snip C3D4E -ContentOnly
Get-Snip C3D4E -AsTable
```

## MCP endpoint

The stateless Streamable HTTP endpoint is `POST /mcp`. Configure an MCP client with that URL and an API key. Lambda accepts bearer authorization and common API-key header formats. The server supports the current `2026-07-28` protocol and the legacy initialize flow used by `2025-11-25`, `2025-06-18`, and `2025-03-26` clients.

To-Do tools are:

- `list_todos` — active only by default, with opt-in completed history
- `get_todo`
- `create_todo`
- `update_todo`
- `complete_todo`
- `delete_todo`
- `clear_completed_todos`

Note/block/category tools are `list_notes`, `get_note`, `get_block`, `update_block`, `create_note`, `update_note`, `delete_note`, `restore_note`, `list_categories`, `create_category`, `rename_category`, and `delete_category`.

`get_block` and `update_block` address a note block directly with its five-character code; CSV data is passed as standard CSV text in `content`. Note deletes are recoverable through the recycle bin. To-Do deletes and clearing completed To-Dos are permanent.

### ChatGPT Business

ChatGPT Business supports custom MCP apps in Developer Mode. Lambda must be reachable from ChatGPT over HTTPS unless Secure MCP Tunnel is being used.

Create a custom app in ChatGPT and use the Lambda MCP URL, for example `https://notes.example.com/mcp`. Choose **API key** authentication with a **Bearer** API key and enter the raw `api_key` configured for Lambda. Then scan the server tools.

After Lambda's MCP tool definitions change, refresh or recreate the draft custom app so ChatGPT scans the current action catalogue. Lambda 1.2.9 and later includes the modern `2026-07-28` action-discovery compatibility path.

## Home Assistant app

Add `https://github.com/Invertee/Lambda` as a repository in the Home Assistant app store, then install **Lambda**. Before starting it, set a password in the Configuration tab.

The SQLite database is written to `/config/snippet.db` inside the container and attachments are stored beside it in `/config/attachments`. The wrapped encryption key metadata is written to `/config/snippet.db.encryption.json`. The `addon_config` mapping exposes that directory under Home Assistant's `addon_configs` storage, so all three are included with app backups.

The app supports Home Assistant Ingress and also publishes port `8099` for a separate reverse proxy. Keep TLS termination at the proxy and forward `X-Forwarded-Proto`; Lambda will add the `Secure` flag to its session cookie when that header is `https`.

## Backups

Lambda JSON exports now include To-Dos as well as notes, recycled notes, categories, tags, and version history. Older version-1 JSON backups that do not contain a `todos` array are still accepted and restore with an empty To-Do list.

For a consistent manual filesystem backup, stop the app and copy `snippet.db`, `snippet.db.encryption.json`, and the `attachments` folder together. Home Assistant app backups include the mapped app configuration directory. SQLite WAL files may be present while the app is running.

## Version behavior

A note snapshot is captured before the first change in an editing session. Long-running sessions rotate to a new snapshot window after five minutes. Restoring a version first snapshots the current note, and only the newest 20 snapshots are retained.
