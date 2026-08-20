# Lambda

Lambda is a small, self-hosted notes, to-do, and script library designed to run as a Home Assistant app. Notes are assembled from text, code, CSV table, image, and file-attachment blocks, while To-Dos are kept in a separate task view with priority ordering, due dates, subtasks, and completion history.

## Highlights

- Single-user password authentication with rate limiting and secure, HTTP-only cookies that expire after 30 days of inactivity by default
- AES-256-GCM encryption at rest for note titles, block content, version content, attachment contents, To-Do titles, and To-Do subtasks
- Separate Microsoft To Do-style task tracking with draggable priority order, active/completed piles, optional due dates, and subtasks
- Stable five-character alphanumeric codes on every note block for direct REST, MCP, and script access
- Text, code, editable CSV table, compressed image, and disk-backed file-attachment blocks
- CSV tables can be edited, sorted, filtered, and downloaded as standard `.csv` files
- A language picker for code blocks, defaulting to PowerShell
- Search across titles, content, block codes, languages, categories, and tags
- Recycle bin plus a rolling 20-snapshot version history per note
- REST and MCP automation interfaces protected by a separate static API key
- PowerShell helpers for note blocks and To-Dos using one saved Lambda connection
- Installable PWA with an IndexedDB snapshot for offline, read-only note viewing
- SQLite WAL storage using Node's built-in SQLite driver and the official MCP TypeScript SDK
- Responsive desktop and mobile layouts

## Run locally

Node.js 22.13 or newer is required because Lambda uses Node's built-in SQLite driver.

```powershell
$env:APP_PASSWORD = 'choose-a-password'
npm install
npm start
```

Open `http://localhost:8099`. The local database is created at `data/snippet.db`, with uploaded files in `data/attachments`. Optional environment variables are `PORT`, `HOST`, `DB_PATH`, `ATTACHMENTS_PATH`, `COOKIE_SECURE`, `SESSION_DAYS`, and `API_KEY`.

## Encryption at rest

Lambda creates a random 256-bit data-encryption key on first start. That key is wrapped with a key derived from the configured app password using scrypt and stored beside the database as `snippet.db.encryption.json`. Note titles, note blocks, version titles, version blocks, To-Do titles, To-Do subtasks, and attachment file contents are encrypted with AES-256-GCM before being written to disk.

Categories, tags, record IDs, timestamps, block codes, To-Do priority values, due dates/completion timestamps, session metadata, and other structural database information remain plaintext so filtering, indexing, ordering, and automation continue to work normally. REST, MCP, and PowerShell/API clients receive decrypted data from the running Lambda service.

The browser's IndexedDB offline snapshot and manually exported Lambda JSON backups remain plaintext on the device where they are created.

## To-Dos

To-Dos are separate from notes and appear above **All notes** in the sidebar. Active tasks are shown in priority order. Checking a task marks it complete, strikes it through, and moves it into the completed pile. Completed items can be reopened individually or cleared permanently as a group.

Each To-Do supports:

- a title
- a persisted priority/order position
- an optional `YYYY-MM-DD` due date
- up to 100 subtasks/steps with independent completion state
- active/completed state and completion timestamp

Active To-Dos can be reordered in the web view using the dedicated drag grip. Only the grip starts a drag, so selecting or editing task text does not move the task. Completing a task removes it from the active priority queue; reopening it appends it to the end.

The default REST, MCP, and PowerShell list operations return **active To-Dos only**. Completed history is queried only when explicitly requested.

## Block codes

Every note block receives a globally unique five-character uppercase alphanumeric code such as `A1B2C`. The code is assigned by the server, returned as the block's `code` property, displayed in the web editor, and can be copied with one click.

A code stays attached to the same block when its content changes or when the block is reordered. Codes are retained as tombstones when blocks are removed so they are not reassigned to a different block. Blocks inside notes in the recycle bin are unavailable through the block API; restoring the note reactivates the original codes.

Legacy `heading` blocks from older Lambda versions are normalised to ordinary text blocks when loaded or validated.

## CSV table blocks

A `csv` block stores standard CSV text in its `content` field. In the web interface Lambda renders that content as an editable table with controls to add/remove rows and columns, sort/filter data, and download the current data as a CSV file. CSV remains the canonical representation used by REST, MCP, and PowerShell.

```csv
Name,Status
Spooler,Running
W32Time,Stopped
```

## Automation API

Set `API_KEY` or `api_key` in the Home Assistant configuration to a long random secret. Automation can use `Authorization: Bearer <key>` or the supported API-key header forms. Keep the endpoint behind HTTPS because the key grants write access.

### To-Do REST operations

- `GET /api/todos` — active To-Dos only, in priority order
- `GET /api/todos/count` — active count only; intended for lightweight shell/profile checks
- `GET /api/todos?include_completed=1` — active and completed To-Dos
- `GET /api/todos?completed=1` — completed To-Dos only
- `GET /api/todos?q=search` — search active To-Dos and subtasks
- `POST /api/todos` — create a To-Do
- `GET /api/todos/:id` — retrieve one To-Do
- `PATCH /api/todos/:id` — partially update title, due date, subtasks, or completion state
- `PUT /api/todos/:id` — replace a To-Do payload
- `PUT /api/todos/order` — persist the priority order; body is `{ "ids": ["uuid", "uuid"] }` containing every active To-Do ID in desired order
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

### Note REST operations

- `GET /api/notes?q=&category=&tag=&trash=1` — list or filter notes
- `POST /api/notes` — create a complete structured note
- `GET /api/notes/:id` — retrieve one note
- `PATCH /api/notes/:id` — update supplied note fields
- `PUT /api/notes/:id` — replace a complete note
- `DELETE /api/notes/:id` — move a note to the recycle bin
- `GET /api/blocks/:code` — retrieve one active block by its five-character code
- `PATCH|PUT /api/blocks/:code` — update a block by code using JSON
- `PUT /api/blocks/:code` with `Content-Type: text/csv` — replace a block with CSV data and make it a table block
- `GET|POST /api/categories`, `PATCH|DELETE /api/categories/:id` — manage categories

## PowerShell helper

The bundled `tools/Lambda.ps1` helper can be loaded from your PowerShell profile so the Lambda URL and API key do not need to be supplied on every command.

```powershell
. .\tools\Lambda.ps1
Install-LambdaProfile -Uri 'https://notes.example.com' -ApiKey $api
```

`Install-LambdaProfile` adds the helper path and saved connection to the current `$PROFILE`. The API key is stored as plaintext in that profile file. It also adds:

```powershell
Show-LambdaTodoSummary -TimeoutMs 200
```

so a new PowerShell session makes a best-effort active-count request with a 200ms HTTP timeout. If Lambda is unavailable or slow, the check fails silently rather than delaying the shell.

The note/block aliases are:

- `New-Snip` → `New-LambdaNote`
- `Get-Snip` → `Get-LambdaBlock`
- `Set-Snip` → `Set-LambdaBlock`

The To-Do commands and aliases are:

- `New-Todo` → `New-LambdaTodo`
- `Get-Todo` → `Get-LambdaTodo`
- `Set-Todo` → `Set-LambdaTodo`
- `Complete-Todo` → `Complete-LambdaTodo`
- `Move-Todo` → `Move-LambdaTodo`
- `Remove-Todo` → `Remove-LambdaTodo`
- `Clear-CompletedTodo` → `Clear-LambdaCompletedTodo`
- `todo` → compact numbered active To-Do list
- `complete` → complete by UUID or by the number shown by `todo`

The normal interactive flow is:

```powershell
todo
```

which displays roughly:

```text
No Due       Task                                      Steps
-- ---       ----                                      -----
1  Today     Fix remaining OneDrive migrations        
2  Tomorrow  Fix teams migrations                     0/2
3  -         Review conditional access                1/3
```

Then:

```powershell
complete 1
```

completes the task currently shown as number 1. Numbering follows the persisted active priority order. If there is no cached list, `complete 1` refreshes the active list first.

You can also move a task from PowerShell:

```powershell
Move-Todo 3 -Position 1
```

`Get-Todo` uses the same compact display. Use `-Raw` when a script needs the original API objects:

```powershell
Get-Todo -Raw
Get-Todo -IncludeCompleted
Get-Todo -CompletedOnly
```

Other examples:

```powershell
New-Todo -Name 'Review tenant' -DueDate tomorrow `
  -Subtask 'Export configuration','Review exclusions'

Set-Todo 2 -DueDate '2026-08-30'
Complete-Todo 2
Remove-Todo 3
Clear-CompletedTodo
```

`New-Snip` accepts `-Name` as an alias for `-Title` and defaults new notes to the `Snippets` category. Structured PowerShell pipeline objects automatically become CSV table blocks.

```powershell
Get-NetAdapter | New-Snip -Name 'net adaptors'
Get-Process | Select-Object Name, Id, CPU | Set-Snip C3D4E
Get-Snip C3D4E -AsTable
```

## MCP endpoint

The Streamable HTTP endpoint is `/mcp`. Lambda uses the official MCP TypeScript SDK v2 and accepts bearer/API-key authentication before passing requests into the SDK transport.

To-Do tools are:

- `list_todos` — active only by default, returned in priority order
- `get_todo`
- `create_todo`
- `update_todo`
- `reorder_todos` — supply every active To-Do UUID in desired priority order
- `complete_todo`
- `delete_todo`
- `clear_completed_todos`

Note/block/category tools are `list_notes`, `get_note`, `get_block`, `update_block`, `create_note`, `update_note`, `delete_note`, `restore_note`, `list_categories`, `create_category`, `rename_category`, and `delete_category`.

### ChatGPT Business

ChatGPT Business supports custom MCP apps in Developer Mode. Lambda must be reachable from ChatGPT over HTTPS unless Secure MCP Tunnel is being used.

Create a custom app using a URL such as `https://notes.example.com/mcp`. Choose **API key** authentication with **Bearer** format and enter the raw `api_key`. After Lambda MCP tool definitions change, refresh or recreate the custom app so ChatGPT scans the current action catalogue.

Lambda logs authenticated MCP requests using sanitized `[Lambda MCP]` lines containing method/protocol/tool name and HTTP status only. API keys and tool content are not logged.

## Home Assistant app

Add `https://github.com/Invertee/Lambda` as a repository in the Home Assistant app store, then install **Lambda**. Before starting it, set a password in the Configuration tab.

The SQLite database is written to `/config/snippet.db`, attachments to `/config/attachments`, and wrapped encryption metadata to `/config/snippet.db.encryption.json`. The app supports Home Assistant Ingress and also publishes port `8099` for a separate reverse proxy.

## Backups

Lambda JSON exports include To-Dos, including their active priority values, as well as notes, recycled notes, categories, tags, and version history. Older version-1 JSON backups without a `todos` array are still accepted.

For a consistent manual filesystem backup, stop the app and copy `snippet.db`, `snippet.db.encryption.json`, and the `attachments` folder together.
