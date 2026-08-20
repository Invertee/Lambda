$script:LambdaHelperVersion = '1.3.0'
$script:LambdaHelperPath = $PSCommandPath

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

    .EXAMPLE
    New-Snip -Name 'Restart service' -Category 'PowerShell' -BlockType code `
        -Language powershell -Content 'Restart-Service Spooler'
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
    <#
    .SYNOPSIS
    Retrieves a Lambda block using its five-character code.

    .EXAMPLE
    Get-Snip A1B2C

    .EXAMPLE
    Get-Snip A1B2C -AsTable
    #>
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
    <#
    .SYNOPSIS
    Replaces the content of a Lambda block using its five-character code.

    .EXAMPLE
    Get-NetAdapter | Set-Snip A1B2C

    .EXAMPLE
    Get-Content .\output.txt | Set-Snip A1B2C
    #>
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

function New-LambdaTodo {
    <#
    .SYNOPSIS
    Creates a Lambda to-do.

    .EXAMPLE
    New-Todo -Name 'Review conditional access' -DueDate tomorrow -Subtask 'Export policies','Review exclusions'
    #>
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

    Invoke-RestMethod `
        -Uri ('{0}/api/todos' -f $connection.Uri) `
        -Method Post `
        -Headers @{ Authorization = "Bearer $($connection.ApiKey)" } `
        -ContentType 'application/json; charset=utf-8' `
        -Body $body
}

function Get-LambdaTodo {
    <#
    .SYNOPSIS
    Gets active Lambda to-dos by default.

    .EXAMPLE
    Get-Todo

    .EXAMPLE
    Get-Todo -IncludeCompleted
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string] $Id,

        [switch] $IncludeCompleted,

        [switch] $CompletedOnly,

        [string] $Query,

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

    Invoke-RestMethod `
        -Uri ('{0}/api/todos{1}' -f $connection.Uri, $suffix) `
        -Method Get `
        -Headers @{ Authorization = "Bearer $($connection.ApiKey)" }
}

function Set-LambdaTodo {
    <#
    .SYNOPSIS
    Updates a Lambda to-do.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [string] $Id,

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
    Invoke-RestMethod `
        -Uri ('{0}/api/todos/{1}' -f $connection.Uri, $Id) `
        -Method Patch `
        -Headers @{ Authorization = "Bearer $($connection.ApiKey)" } `
        -ContentType 'application/json; charset=utf-8' `
        -Body ($body | ConvertTo-Json -Depth 8)
}

function Complete-LambdaTodo {
    <#
    .SYNOPSIS
    Completes a Lambda to-do, or reopens it with Reopen.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [string] $Id,

        [switch] $Reopen,

        [string] $Uri,

        [string] $ApiKey
    )

    process {
        Set-LambdaTodo -Id $Id -Complete:(-not $Reopen) -Reopen:$Reopen -Uri $Uri -ApiKey $ApiKey
    }
}

function Remove-LambdaTodo {
    <#
    .SYNOPSIS
    Permanently removes a Lambda to-do.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [string] $Id,

        [string] $Uri,

        [string] $ApiKey
    )

    process {
        $connection = Resolve-LambdaConnection -Uri $Uri -ApiKey $ApiKey
        Invoke-RestMethod `
            -Uri ('{0}/api/todos/{1}' -f $connection.Uri, $Id) `
            -Method Delete `
            -Headers @{ Authorization = "Bearer $($connection.ApiKey)" }
    }
}

function Clear-LambdaCompletedTodo {
    <#
    .SYNOPSIS
    Permanently clears every completed Lambda to-do.
    #>
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
Set-Alias -Name Remove-Todo -Value Remove-LambdaTodo -Scope Global -Force
Set-Alias -Name Clear-CompletedTodo -Value Clear-LambdaCompletedTodo -Scope Global -Force
