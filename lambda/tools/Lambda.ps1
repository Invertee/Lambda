$script:LambdaHelperVersion = '1.3.5'
$script:LambdaHelperPath = $PSCommandPath
$script:LambdaTodoCache = @()
$script:LambdaTodoCacheLoaded = $false
$script:LambdaTodoCountCacheRoot = if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    Join-Path $env:LOCALAPPDATA 'Lambda'
}
else {
    Join-Path $HOME '.lambda'
}
$script:LambdaTodoCountCachePath = Join-Path $script:LambdaTodoCountCacheRoot 'todo-count.json'

Update-TypeData -TypeName 'Lambda.TodoView' -DefaultDisplayPropertySet 'No','Due','Task','Steps' -Force

if (-not (Get-Variable -Name LambdaConnection -Scope Global -ErrorAction SilentlyContinue)) {
    $Global:LambdaConnection = [ordered]@{
        Uri    = $env:LAMBDA_URL
        ApiKey = $env:LAMBDA_API_KEY
    }
}

function Set-LambdaConnection {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Uri,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $ApiKey
    )

    $Global:LambdaConnection = [ordered]@{
        Uri    = $Uri.TrimEnd('/')
        ApiKey = $ApiKey
    }
    $script:LambdaTodoCache = @()
    $script:LambdaTodoCacheLoaded = $false
}

function Install-LambdaProfile {
    <#
    .SYNOPSIS
    Adds Lambda to the current PowerShell profile with a saved URL and API key.

    .EXAMPLE
    Install-LambdaProfile -Uri 'https://notes.example.com' -ApiKey $api
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Uri,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $ApiKey,

        [string] $HelperPath = $script:LambdaHelperPath,

        [string] $ProfilePath = $PROFILE
    )

    if ([string]::IsNullOrWhiteSpace($HelperPath)) {
        throw 'Lambda.ps1 must be saved to disk before it can be added to your profile.'
    }

    $resolvedHelper = (Resolve-Path -LiteralPath $HelperPath -ErrorAction Stop).Path
    $profileDirectory = Split-Path -Parent $ProfilePath
    if (-not (Test-Path -LiteralPath $profileDirectory)) {
        New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
    }

    $escapedHelper = $resolvedHelper.Replace("'", "''")
    $escapedUri = $Uri.TrimEnd('/').Replace("'", "''")
    $escapedApiKey = $ApiKey.Replace("'", "''")
    $startMarker = '# Lambda helper start'
    $endMarker = '# Lambda helper end'
    $profileBlock = @"
$startMarker
. '$escapedHelper'
Set-LambdaConnection -Uri '$escapedUri' -ApiKey '$escapedApiKey'
Show-LambdaTodoSummary -TimeoutMs 225
$endMarker
"@

    $existing = if (Test-Path -LiteralPath $ProfilePath) {
        Get-Content -LiteralPath $ProfilePath -Raw
    }
    else {
        ''
    }

    $pattern = '(?s)' + [regex]::Escape($startMarker) + '.*?' + [regex]::Escape($endMarker)
    if ($existing -match $pattern) {
        $updated = [regex]::Replace($existing, $pattern, $profileBlock)
    }
    elseif ([string]::IsNullOrWhiteSpace($existing)) {
        $updated = $profileBlock
    }
    else {
        $updated = $existing.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $profileBlock
    }

    Set-Content -LiteralPath $ProfilePath -Value $updated -Encoding utf8
    Set-LambdaConnection -Uri $Uri -ApiKey $ApiKey
    Show-LambdaTodoSummary -TimeoutMs 225
}

function Resolve-LambdaConnection {
    param(
        [string] $Uri,
        [string] $ApiKey
    )

    $resolvedUri = $Uri
    if ([string]::IsNullOrWhiteSpace($resolvedUri)) {
        $resolvedUri = $Global:LambdaConnection.Uri
    }
    if ([string]::IsNullOrWhiteSpace($resolvedUri)) {
        $resolvedUri = $env:LAMBDA_URL
    }

    $resolvedApiKey = $ApiKey
    if ([string]::IsNullOrWhiteSpace($resolvedApiKey)) {
        $resolvedApiKey = $Global:LambdaConnection.ApiKey
    }
    if ([string]::IsNullOrWhiteSpace($resolvedApiKey)) {
        $resolvedApiKey = $env:LAMBDA_API_KEY
    }

    if ([string]::IsNullOrWhiteSpace($resolvedUri)) {
        throw 'Set the Lambda URL with Set-LambdaConnection, -Uri, or LAMBDA_URL.'
    }
    if ([string]::IsNullOrWhiteSpace($resolvedApiKey)) {
        throw 'Set the Lambda API key with Set-LambdaConnection, -ApiKey, or LAMBDA_API_KEY.'
    }

    [pscustomobject]@{
        Uri    = $resolvedUri.TrimEnd('/')
        ApiKey = $resolvedApiKey
    }
}

function Set-LambdaTodoCountCache {
    param(
        [Parameter(Mandatory)]
        [ValidateRange(0, 1000000)]
        [int] $Count
    )

    try {
        if (-not (Test-Path -LiteralPath $script:LambdaTodoCountCacheRoot)) {
            New-Item -ItemType Directory -Path $script:LambdaTodoCountCacheRoot -Force | Out-Null
        }
        [pscustomobject]@{
            active    = $Count
            updatedAt = (Get-Date).ToString('o')
        } |
            ConvertTo-Json -Compress |
            Set-Content -LiteralPath $script:LambdaTodoCountCachePath -Encoding utf8
    }
    catch {
    }
}

function Get-LambdaTodoCountCache {
    try {
        if (-not (Test-Path -LiteralPath $script:LambdaTodoCountCachePath)) {
            return $null
        }
        $payload = Get-Content -LiteralPath $script:LambdaTodoCountCachePath -Raw | ConvertFrom-Json
        if ($null -eq $payload -or $null -eq $payload.active) {
            return $null
        }
        return [pscustomobject]@{
            active    = [int] $payload.active
            updatedAt = $payload.updatedAt
        }
    }
    catch {
        return $null
    }
}

function Show-LambdaTodoSummary {
    <#
    .SYNOPSIS
    Shows the active Lambda to-do count with a hard startup wait and a local cached fallback.
    #>
    [CmdletBinding()]
    param(
        [ValidateRange(50, 249)]
        [int] $TimeoutMs = 225,

        [switch] $PassThru,

        [string] $Uri,

        [string] $ApiKey
    )

    $client = $null
    $request = $null
    $response = $null
    $freshCount = $null

    try {
        $connection = Resolve-LambdaConnection -Uri $Uri -ApiKey $ApiKey
        $client = [System.Net.Http.HttpClient]::new()
        $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
        $request = [System.Net.Http.HttpRequestMessage]::new(
            [System.Net.Http.HttpMethod]::Get,
            ('{0}/api/todos/count' -f $connection.Uri)
        )
        $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $connection.ApiKey)

        $task = $client.SendAsync($request)
        if ($task.Wait($TimeoutMs)) {
            $response = $task.GetAwaiter().GetResult()
            if ($response.IsSuccessStatusCode) {
                $payload = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
                $freshCount = [int] $payload.active
                Set-LambdaTodoCountCache -Count $freshCount
            }
        }
    }
    catch {
    }
    finally {
        if ($null -ne $response) {
            $response.Dispose()
        }
        if ($null -ne $request) {
            $request.Dispose()
        }
        if ($null -ne $client) {
            $client.Dispose()
        }
    }

    $cached = $null
    $label = ''
    if ($null -ne $freshCount) {
        $count = $freshCount
    }
    else {
        $cached = Get-LambdaTodoCountCache
        if ($null -eq $cached) {
            return
        }
        $count = [int] $cached.active
        $label = ' cached'
    }

    $suffix = if ($count -eq 1) { '' } else { 's' }
    Write-Host ('Lambda {0} active to-do{1}{2}' -f $count, $suffix, $label)
    if ($PassThru) {
        return $count
    }
}

function Expand-LambdaRestCollection {
    param(
        [AllowNull()]
        [object] $Value
    )

    $items = [System.Collections.Generic.List[object]]::new()
    if ($null -eq $Value) {
        return @()
    }

    if ($Value -is [System.Array] -or ($Value -is [System.Collections.IList] -and $Value -isnot [string])) {
        foreach ($item in $Value) {
            $items.Add($item)
        }
    }
    else {
        $items.Add($Value)
    }

    return $items.ToArray()
}

function ConvertTo-LambdaDueDate {
    param(
        [AllowNull()]
        [object] $Value
    )

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string] $Value)) {
        return $null
    }
    if ($Value -is [datetime]) {
        return $Value.ToString('yyyy-MM-dd')
    }

    $text = ([string] $Value).Trim()
    if ($text -ieq 'today') {
        return (Get-Date).ToString('yyyy-MM-dd')
    }
    if ($text -ieq 'tomorrow') {
        return (Get-Date).Date.AddDays(1).ToString('yyyy-MM-dd')
    }

    $parsed = [datetime]::MinValue
    if (-not [datetime]::TryParse($text, [ref] $parsed)) {
        throw 'DueDate must be a valid date, today, or tomorrow.'
    }
    return $parsed.ToString('yyyy-MM-dd')
}

function ConvertTo-LambdaCellValue {
    param(
        [AllowNull()]
        [object] $Value
    )

    if ($null -eq $Value) {
        return ''
    }
    if ($Value -is [string]) {
        return $Value
    }
    if ($Value -is [System.Collections.IDictionary]) {
        return (($Value.GetEnumerator() | ForEach-Object { '{0}={1}' -f $_.Key, $_.Value }) -join '; ')
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        return ((@($Value) | ForEach-Object { [string] $_ }) -join '; ')
    }
    return $Value
}

function ConvertTo-LambdaDisplayObject {
    param(
        [AllowNull()]
        [object] $InputObject
    )

    if ($null -eq $InputObject) {
        return [pscustomobject]@{ Value = '' }
    }
    if ($InputObject -is [string]) {
        return [pscustomobject]@{ Value = $InputObject }
    }

    $propertyNames = @()
    $defaultDisplaySet = $InputObject.PSStandardMembers.DefaultDisplayPropertySet
    if ($null -ne $defaultDisplaySet) {
        $propertyNames = @(
            $defaultDisplaySet.ReferencedPropertyNames |
                Where-Object { $_ -is [string] -and -not [string]::IsNullOrWhiteSpace($_) } |
                Select-Object -Unique
        )
    }

    if (-not $propertyNames.Count) {
        $propertyNames = @(
            $InputObject.PSObject.Properties |
                Where-Object {
                    $_.IsGettable -and
                    $_.MemberType -in @('AliasProperty', 'CodeProperty', 'NoteProperty', 'Property', 'ScriptProperty') -and
                    -not [string]::IsNullOrWhiteSpace($_.Name)
                } |
                ForEach-Object { $_.Name } |
                Select-Object -Unique
        )
    }

    if (-not $propertyNames.Count) {
        return [pscustomobject]@{ Value = [string] $InputObject }
    }

    $row = [ordered]@{}
    foreach ($propertyName in $propertyNames) {
        if ([string]::IsNullOrWhiteSpace($propertyName)) {
            continue
        }

        $property = $InputObject.PSObject.Properties[$propertyName]
        if ($null -eq $property) {
            $row[$propertyName] = ''
            continue
        }

        try {
            $row[$propertyName] = ConvertTo-LambdaCellValue -Value $property.Value
        }
        catch {
            $row[$propertyName] = ''
        }
    }

    if (-not $row.Count) {
        return [pscustomobject]@{ Value = [string] $InputObject }
    }

    return [pscustomobject] $row
}

function ConvertTo-LambdaCsvContent {
    param(
        [object[]] $Items
    )

    $rows = @($Items | ForEach-Object { ConvertTo-LambdaDisplayObject -InputObject $_ })
    return (($rows | ConvertTo-Csv -NoTypeInformation) -join [Environment]::NewLine)
}

function New-LambdaNote {
    <#
    .SYNOPSIS
    Posts a new note to Lambda using its static API key.

    .EXAMPLE
    Get-NetAdapter | New-Snip -Name 'net adaptors'
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [Alias('Name')]
        [ValidateNotNullOrEmpty()]
        [string] $Title,

        [ValidateNotNullOrEmpty()]
        [string] $Category = 'Snippets',

        [string[]] $Tags = @(),

        [Parameter(ValueFromPipeline)]
        [AllowNull()]
        [object] $Content = '',

        [ValidateSet('auto', 'text', 'code', 'csv')]
        [string] $BlockType = 'auto',

        [string] $Language = 'powershell',

        [string] $Uri,

        [string] $ApiKey
    )

    begin {
        $contentParts = [System.Collections.Generic.List[object]]::new()
        $hasStructuredInput = $false
    }

    process {
        if ($null -eq $Content) {
            $contentParts.Add($null)
        }
        elseif ($Content -is [string] -or $Content -is [System.Collections.IDictionary]) {
            $contentParts.Add($Content)
            if ($Content -isnot [string]) {
                $hasStructuredInput = $true
            }
        }
        elseif ($Content -is [System.Collections.IEnumerable]) {
            foreach ($item in $Content) {
                $contentParts.Add($item)
                if ($null -ne $item -and $item -isnot [string]) {
                    $hasStructuredInput = $true
                }
            }
        }
        else {
            $contentParts.Add($Content)
            $hasStructuredInput = $true
        }
    }

    end {
        $connection = Resolve-LambdaConnection -Uri $Uri -ApiKey $ApiKey
        $effectiveBlockType = if ($BlockType -eq 'auto') {
            if ($hasStructuredInput) { 'csv' } else { 'text' }
        }
        else {
            $BlockType
        }

        if ($effectiveBlockType -eq 'csv' -and $hasStructuredInput) {
            $blockContent = ConvertTo-LambdaCsvContent -Items @($contentParts)
        }
        else {
            $blockContent = ($contentParts | ForEach-Object { [string] $_ }) -join [Environment]::NewLine
        }

        $block = [ordered]@{
            id      = [guid]::NewGuid().ToString()
            type    = $effectiveBlockType
            content = $blockContent
        }
        if ($effectiveBlockType -eq 'code') {
            $block.language = $Language
        }

        $body = [ordered]@{
            title    = $Title
            category = $Category
            tags     = @($Tags)
            blocks   = @($block)
        } | ConvertTo-Json -Depth 10

        Invoke-RestMethod `
            -Uri ('{0}/api/notes' -f $connection.Uri) `
            -Method Post `
            -Headers @{ Authorization = "Bearer $($connection.ApiKey)" } `
            -ContentType 'application/json; charset=utf-8' `
            -Body $body
    }
}

function Get-LambdaBlock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [ValidatePattern('^[A-Za-z0-9]{5}$')]
        [string] $Code,

        [switch] $ContentOnly,

        [switch] $AsTable,

        [string] $Uri,

        [string] $ApiKey
    )

    $connection = Resolve-LambdaConnection -Uri $Uri -ApiKey $ApiKey
    $result = Invoke-RestMethod `
        -Uri ('{0}/api/blocks/{1}' -f $connection.Uri, $Code.ToUpperInvariant()) `
        -Method Get `
        -Headers @{ Authorization = "Bearer $($connection.ApiKey)" }

    if ($AsTable) {
        if ($result.block.type -ne 'csv') {
            throw 'The requested block is not a CSV table block.'
        }
        return $result.block.content | ConvertFrom-Csv
    }
    if ($ContentOnly) {
        return $result.block.content
    }
    return $result
}

function Set-LambdaBlock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [ValidatePattern('^[A-Za-z0-9]{5}$')]
        [string] $Code,

        [Parameter(ValueFromPipeline)]
        [AllowNull()]
        [object] $InputObject,

        [ValidateSet('text', 'code', 'csv')]
        [string] $BlockType,

        [string] $Language,

        [switch] $AsCsv,

        [string] $Uri,

        [string] $ApiKey
    )

    begin {
        $items = [System.Collections.Generic.List[object]]::new()
        $hasStructuredInput = $false
    }

    process {
        if ($null -eq $InputObject) {
            $items.Add($null)
        }
        elseif ($InputObject -is [string] -or $InputObject -is [System.Collections.IDictionary]) {
            $items.Add($InputObject)
            if ($InputObject -isnot [string]) {
                $hasStructuredInput = $true
            }
        }
        elseif ($InputObject -is [System.Collections.IEnumerable]) {
            foreach ($item in $InputObject) {
                $items.Add($item)
                if ($null -ne $item -and $item -isnot [string]) {
                    $hasStructuredInput = $true
                }
            }
        }
        else {
            $items.Add($InputObject)
            $hasStructuredInput = $true
        }
    }

    end {
        $connection = Resolve-LambdaConnection -Uri $Uri -ApiKey $ApiKey
        $useCsv = $AsCsv -or $BlockType -eq 'csv' -or (-not $PSBoundParameters.ContainsKey('BlockType') -and $hasStructuredInput)

        if ($useCsv -and $hasStructuredInput) {
            $content = ConvertTo-LambdaCsvContent -Items @($items)
        }
        else {
            $content = ($items | ForEach-Object { [string] $_ }) -join [Environment]::NewLine
        }

        $body = [ordered]@{ content = $content }
        if ($useCsv) {
            $body.type = 'csv'
        }
        elseif ($PSBoundParameters.ContainsKey('BlockType')) {
            $body.type = $BlockType
        }
        if ($PSBoundParameters.ContainsKey('Language')) {
            $body.language = $Language
        }

        Invoke-RestMethod `
            -Uri ('{0}/api/blocks/{1}' -f $connection.Uri, $Code.ToUpperInvariant()) `
            -Method Put `
            -Headers @{ Authorization = "Bearer $($connection.ApiKey)" } `
            -ContentType 'application/json; charset=utf-8' `
            -Body ($body | ConvertTo-Json -Depth 5)
    }
}

function ConvertTo-LambdaTodoDueLabel {
    param(
        [AllowNull()]
        [string] $DueDate,

        [bool] $Completed = $false
    )

    if ($Completed) {
        return 'Done'
    }
    if ([string]::IsNullOrWhiteSpace($DueDate)) {
        return '-'
    }

    $today = (Get-Date).Date
    $due = [datetime]::ParseExact($DueDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
    if ($due -eq $today) {
        return 'Today'
    }
    if ($due -eq $today.AddDays(1)) {
        return 'Tomorrow'
    }
    if ($due -lt $today) {
        return 'Overdue'
    }
    return $due.ToString('dd MMM')
}

function ConvertTo-LambdaTodoView {
    param(
        [object[]] $Todos
    )

    $number = 0
    foreach ($todo in $Todos) {
        $todoNumber = ''
        if (-not $todo.completed) {
            $number++
            $todoNumber = $number
        }
        $steps = ''
        $subtasks = @($todo.subtasks)
        if ($subtasks.Count) {
            $done = @($subtasks | Where-Object { $_.completed }).Count
            $steps = '{0}/{1}' -f $done, $subtasks.Count
        }

        [pscustomobject]@{
            PSTypeName  = 'Lambda.TodoView'
            No          = $todoNumber
            Due         = ConvertTo-LambdaTodoDueLabel -DueDate $todo.dueDate -Completed ([bool] $todo.completed)
            Task        = $todo.title
            Steps       = $steps
            Id          = $todo.id
            Priority    = $todo.priority
            Title       = $todo.title
            DueDate     = $todo.dueDate
            Subtasks    = $todo.subtasks
            Completed   = $todo.completed
            CompletedAt = $todo.completedAt
            CreatedAt   = $todo.createdAt
            UpdatedAt   = $todo.updatedAt
        }
    }
}

function New-LambdaTodo {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [Alias('Name')]
        [ValidateNotNullOrEmpty()]
        [string] $Title,

        [AllowNull()]
        [object] $DueDate,

        [string[]] $Subtask = @(),

        [string] $Uri,

        [string] $ApiKey
    )

    $connection = Resolve-LambdaConnection -Uri $Uri -ApiKey $ApiKey
    $subtasks = @($Subtask | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
        [ordered]@{
            title     = $_.Trim()
            completed = $false
        }
    })
    $body = [ordered]@{
        title    = $Title
        dueDate  = ConvertTo-LambdaDueDate -Value $DueDate
        subtasks = $subtasks
    } | ConvertTo-Json -Depth 8

    $created = Invoke-RestMethod `
        -Uri ('{0}/api/todos' -f $connection.Uri) `
        -Method Post `
        -Headers @{ Authorization = "Bearer $($connection.ApiKey)" } `
        -ContentType 'application/json; charset=utf-8' `
        -Body $body

    if ($script:LambdaTodoCacheLoaded) {
        $script:LambdaTodoCache = @($script:LambdaTodoCache) + @($created)
        Set-LambdaTodoCountCache -Count $script:LambdaTodoCache.Count
    }
    return $created
}

function Get-LambdaTodo {
    <#
    .SYNOPSIS
    Gets active Lambda to-dos in a compact numbered view by default.

    .EXAMPLE
    todo

    .EXAMPLE
    Get-Todo -Raw
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string] $Id,

        [switch] $IncludeCompleted,

        [switch] $CompletedOnly,

        [string] $Query,

        [switch] $Raw,

        [string] $Uri,

        [string] $ApiKey
    )

    $connection = Resolve-LambdaConnection -Uri $Uri -ApiKey $ApiKey
    if (-not [string]::IsNullOrWhiteSpace($Id)) {
        return Invoke-RestMethod `
            -Uri ('{0}/api/todos/{1}' -f $connection.Uri, $Id) `
            -Method Get `
            -Headers @{ Authorization = "Bearer $($connection.ApiKey)" }
    }

    $parameters = [System.Collections.Generic.List[string]]::new()
    if ($IncludeCompleted) {
        $parameters.Add('include_completed=1')
    }
    if ($CompletedOnly) {
        $parameters.Add('completed=1')
    }
    if (-not [string]::IsNullOrWhiteSpace($Query)) {
        $parameters.Add(('q={0}' -f [uri]::EscapeDataString($Query)))
    }
    $suffix = if ($parameters.Count) { '?' + ($parameters -join '&') } else { '' }

    $response = Invoke-RestMethod `
        -Uri ('{0}/api/todos{1}' -f $connection.Uri, $suffix) `
        -Method Get `
        -Headers @{ Authorization = "Bearer $($connection.ApiKey)" }
    $result = @(Expand-LambdaRestCollection -Value $response)

    if (-not $CompletedOnly) {
        $script:LambdaTodoCache = @($result | Where-Object { -not $_.completed })
        $script:LambdaTodoCacheLoaded = $true
        if ([string]::IsNullOrWhiteSpace($Query)) {
            Set-LambdaTodoCountCache -Count $script:LambdaTodoCache.Count
        }
    }

    if ($Raw) {
        return $result
    }
    return ConvertTo-LambdaTodoView -Todos $result
}

function Resolve-LambdaTodoId {
    param(
        [Parameter(Mandatory)]
        [object] $Value,

        [string] $Uri,

        [string] $ApiKey
    )

    if ($null -ne $Value.PSObject.Properties['Id'] -and -not [string]::IsNullOrWhiteSpace([string] $Value.Id)) {
        return [string] $Value.Id
    }

    $text = ([string] $Value).Trim()
    $number = 0
    if ([int]::TryParse($text, [ref] $number)) {
        if (-not $script:LambdaTodoCacheLoaded) {
            $null = @(Get-LambdaTodo -Raw -Uri $Uri -ApiKey $ApiKey)
        }
        if ($number -lt 1 -or $number -gt $script:LambdaTodoCache.Count) {
            throw ('To-do number {0} is not in the current active list. Run todo to refresh the numbering.' -f $number)
        }
        return [string] $script:LambdaTodoCache[$number - 1].id
    }

    return $text
}

function Set-LambdaTodo {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [object] $Id,

        [string] $Title,

        [AllowNull()]
        [object] $DueDate,

        [switch] $ClearDueDate,

        [string[]] $Subtask,

        [switch] $Complete,

        [switch] $Reopen,

        [string] $Uri,

        [string] $ApiKey
    )

    if ($Complete -and $Reopen) {
        throw 'Use either Complete or Reopen, not both.'
    }

    $resolvedId = Resolve-LambdaTodoId -Value $Id -Uri $Uri -ApiKey $ApiKey
    $body = [ordered]@{}
    if ($PSBoundParameters.ContainsKey('Title')) {
        $body.title = $Title
    }
    if ($ClearDueDate) {
        $body.dueDate = $null
    }
    elseif ($PSBoundParameters.ContainsKey('DueDate')) {
        $body.dueDate = ConvertTo-LambdaDueDate -Value $DueDate
    }
    if ($PSBoundParameters.ContainsKey('Subtask')) {
        $body.subtasks = @($Subtask | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
            [ordered]@{
                title     = $_.Trim()
                completed = $false
            }
        })
    }
    if ($Complete) {
        $body.completed = $true
    }
    if ($Reopen) {
        $body.completed = $false
    }
    if (-not $body.Count) {
        throw 'Supply at least one change.'
    }

    $connection = Resolve-LambdaConnection -Uri $Uri -ApiKey $ApiKey
    $updated = Invoke-RestMethod `
        -Uri ('{0}/api/todos/{1}' -f $connection.Uri, $resolvedId) `
        -Method Patch `
        -Headers @{ Authorization = "Bearer $($connection.ApiKey)" } `
        -ContentType 'application/json; charset=utf-8' `
        -Body ($body | ConvertTo-Json -Depth 8)

    if ($script:LambdaTodoCacheLoaded) {
        $next = [System.Collections.Generic.List[object]]::new()
        $matched = $false
        foreach ($todoItem in $script:LambdaTodoCache) {
            if ($todoItem.id -eq $updated.id) {
                $matched = $true
                if (-not $updated.completed) {
                    $next.Add($updated)
                }
            }
            else {
                $next.Add($todoItem)
            }
        }
        if (-not $matched -and -not $updated.completed) {
            $next.Add($updated)
        }
        $script:LambdaTodoCache = $next.ToArray()
        Set-LambdaTodoCountCache -Count $script:LambdaTodoCache.Count
    }
    return $updated
}

function Complete-LambdaTodo {
    <#
    .SYNOPSIS
    Completes a Lambda to-do by UUID or by the number shown by todo.

    .EXAMPLE
    complete 1
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
        [object] $Id,

        [switch] $Reopen,

        [switch] $PassThru,

        [string] $Uri,

        [string] $ApiKey
    )

    process {
        $updated = Set-LambdaTodo -Id $Id -Complete:(-not $Reopen) -Reopen:$Reopen -Uri $Uri -ApiKey $ApiKey
        $verb = if ($Reopen) { 'Reopened' } else { 'Completed' }
        Write-Host ('{0} {1}' -f $verb, $updated.title)
        if ($PassThru) {
            return $updated
        }
    }
}

function Move-LambdaTodo {
    <#
    .SYNOPSIS
    Moves an active to-do to a new priority position.

    .EXAMPLE
    Move-Todo 3 -Position 1
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [object] $Id,

        [Parameter(Mandatory, Position = 1)]
        [ValidateRange(1, 100000)]
        [int] $Position,

        [string] $Uri,

        [string] $ApiKey
    )

    $resolvedId = Resolve-LambdaTodoId -Value $Id -Uri $Uri -ApiKey $ApiKey
    $active = @(Get-LambdaTodo -Raw -Uri $Uri -ApiKey $ApiKey)
    $target = $active | Where-Object { $_.id -eq $resolvedId } | Select-Object -First 1
    if ($null -eq $target) {
        throw 'Active to-do not found.'
    }

    $items = [System.Collections.ArrayList]::new()
    foreach ($todoItem in $active) {
        if ($todoItem.id -ne $resolvedId) {
            [void] $items.Add($todoItem)
        }
    }
    $insertAt = [Math]::Min($Position - 1, $items.Count)
    $items.Insert($insertAt, $target)

    $connection = Resolve-LambdaConnection -Uri $Uri -ApiKey $ApiKey
    $body = @{ ids = @($items | ForEach-Object { $_.id }) } | ConvertTo-Json -Depth 4
    $response = Invoke-RestMethod `
        -Uri ('{0}/api/todos/order' -f $connection.Uri) `
        -Method Put `
        -Headers @{ Authorization = "Bearer $($connection.ApiKey)" } `
        -ContentType 'application/json; charset=utf-8' `
        -Body $body
    $ordered = @(Expand-LambdaRestCollection -Value $response)

    $script:LambdaTodoCache = $ordered
    $script:LambdaTodoCacheLoaded = $true
    Set-LambdaTodoCountCache -Count $ordered.Count
    return ConvertTo-LambdaTodoView -Todos $ordered
}

function Remove-LambdaTodo {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
        [object] $Id,

        [string] $Uri,

        [string] $ApiKey
    )

    process {
        $resolvedId = Resolve-LambdaTodoId -Value $Id -Uri $Uri -ApiKey $ApiKey
        $connection = Resolve-LambdaConnection -Uri $Uri -ApiKey $ApiKey
        Invoke-RestMethod `
            -Uri ('{0}/api/todos/{1}' -f $connection.Uri, $resolvedId) `
            -Method Delete `
            -Headers @{ Authorization = "Bearer $($connection.ApiKey)" }
        if ($script:LambdaTodoCacheLoaded) {
            $script:LambdaTodoCache = @($script:LambdaTodoCache | Where-Object { $_.id -ne $resolvedId })
            Set-LambdaTodoCountCache -Count $script:LambdaTodoCache.Count
        }
    }
}

function Clear-LambdaCompletedTodo {
    [CmdletBinding()]
    param(
        [string] $Uri,

        [string] $ApiKey
    )

    $connection = Resolve-LambdaConnection -Uri $Uri -ApiKey $ApiKey
    Invoke-RestMethod `
        -Uri ('{0}/api/todos/completed' -f $connection.Uri) `
        -Method Delete `
        -Headers @{ Authorization = "Bearer $($connection.ApiKey)" }
}

Set-Alias -Name New-Snip -Value New-LambdaNote -Scope Global -Force
Set-Alias -Name Get-Snip -Value Get-LambdaBlock -Scope Global -Force
Set-Alias -Name Set-Snip -Value Set-LambdaBlock -Scope Global -Force
Set-Alias -Name New-Todo -Value New-LambdaTodo -Scope Global -Force
Set-Alias -Name Get-Todo -Value Get-LambdaTodo -Scope Global -Force
Set-Alias -Name Set-Todo -Value Set-LambdaTodo -Scope Global -Force
Set-Alias -Name Complete-Todo -Value Complete-LambdaTodo -Scope Global -Force
Set-Alias -Name Move-Todo -Value Move-LambdaTodo -Scope Global -Force
Set-Alias -Name Remove-Todo -Value Remove-LambdaTodo -Scope Global -Force
Set-Alias -Name Clear-CompletedTodo -Value Clear-LambdaCompletedTodo -Scope Global -Force
Set-Alias -Name todo -Value Get-LambdaTodo -Scope Global -Force
Set-Alias -Name complete -Value Complete-LambdaTodo -Scope Global -Force
