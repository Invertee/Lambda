function New-LambdaNote {
    <#
    .SYNOPSIS
    Posts a new note to Lambda using its static API key.

    .EXAMPLE
    New-LambdaNote -Title 'Restart service' -Category 'PowerShell' -Tags admin,windows `
        -BlockType code -Language powershell -Content 'Restart-Service Spooler'

    .EXAMPLE
    Get-Service | Select-Object Name, Status | New-LambdaNote -Title 'Service state' `
        -Category 'Diagnostics' -BlockType csv
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string] $Title,

        [ValidateNotNullOrEmpty()]
        [string] $Category = 'General',

        [string[]] $Tags = @(),

        [Parameter(ValueFromPipeline)]
        [AllowNull()]
        [object] $Content = '',

        [ValidateSet('text', 'heading', 'code', 'csv')]
        [string] $BlockType = 'text',

        [string] $Language = 'powershell',

        [string] $Uri = $env:LAMBDA_URL,

        [string] $ApiKey = $env:LAMBDA_API_KEY
    )

    begin {
        $contentParts = [System.Collections.Generic.List[object]]::new()
    }

    process {
        $contentParts.Add($Content)
    }

    end {
        if ([string]::IsNullOrWhiteSpace($Uri)) {
            throw 'Set -Uri or the LAMBDA_URL environment variable.'
        }
        if ([string]::IsNullOrWhiteSpace($ApiKey)) {
            throw 'Set -ApiKey or the LAMBDA_API_KEY environment variable.'
        }

        if ($BlockType -eq 'csv' -and ($contentParts | Where-Object { $_ -isnot [string] }).Count -gt 0) {
            $blockContent = ($contentParts | ConvertTo-Csv -NoTypeInformation) -join [Environment]::NewLine
        }
        else {
            $blockContent = ($contentParts | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        }

        $block = [ordered]@{
            id      = [guid]::NewGuid().ToString()
            type    = $BlockType
            content = $blockContent
        }
        if ($BlockType -eq 'code') {
            $block.language = $Language
        }
        if ($BlockType -eq 'heading') {
            $block.level = 2
        }

        $body = [ordered]@{
            title    = $Title
            category = $Category
            tags     = @($Tags)
            blocks   = @($block)
        } | ConvertTo-Json -Depth 10

        Invoke-RestMethod `
            -Uri ('{0}/api/notes' -f $Uri.TrimEnd('/')) `
            -Method Post `
            -Headers @{ Authorization = "Bearer $ApiKey" } `
            -ContentType 'application/json; charset=utf-8' `
            -Body $body
    }
}

function Get-LambdaBlock {
    <#
    .SYNOPSIS
    Retrieves a Lambda block using its five-character code.

    .EXAMPLE
    Get-LambdaBlock -Code A1B2C

    .EXAMPLE
    Get-LambdaBlock -Code A1B2C -ContentOnly

    .EXAMPLE
    Get-LambdaBlock -Code A1B2C -AsTable
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidatePattern('^[A-Za-z0-9]{5}$')]
        [string] $Code,

        [switch] $ContentOnly,

        [switch] $AsTable,

        [string] $Uri = $env:LAMBDA_URL,

        [string] $ApiKey = $env:LAMBDA_API_KEY
    )

    if ([string]::IsNullOrWhiteSpace($Uri)) {
        throw 'Set -Uri or the LAMBDA_URL environment variable.'
    }
    if ([string]::IsNullOrWhiteSpace($ApiKey)) {
        throw 'Set -ApiKey or the LAMBDA_API_KEY environment variable.'
    }

    $result = Invoke-RestMethod `
        -Uri ('{0}/api/blocks/{1}' -f $Uri.TrimEnd('/'), $Code.ToUpperInvariant()) `
        -Method Get `
        -Headers @{ Authorization = "Bearer $ApiKey" }

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
    Get-Content .\output.txt | Set-LambdaBlock -Code A1B2C

    .EXAMPLE
    Get-Process | Select-Object Name, Id, CPU | Set-LambdaBlock -Code C3D4E -AsCsv
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidatePattern('^[A-Za-z0-9]{5}$')]
        [string] $Code,

        [Parameter(ValueFromPipeline)]
        [AllowNull()]
        [object] $InputObject,

        [ValidateSet('text', 'heading', 'code', 'csv')]
        [string] $BlockType,

        [string] $Language,

        [switch] $AsCsv,

        [string] $Uri = $env:LAMBDA_URL,

        [string] $ApiKey = $env:LAMBDA_API_KEY
    )

    begin {
        $items = [System.Collections.Generic.List[object]]::new()
    }

    process {
        $items.Add($InputObject)
    }

    end {
        if ([string]::IsNullOrWhiteSpace($Uri)) {
            throw 'Set -Uri or the LAMBDA_URL environment variable.'
        }
        if ([string]::IsNullOrWhiteSpace($ApiKey)) {
            throw 'Set -ApiKey or the LAMBDA_API_KEY environment variable.'
        }

        $useCsv = $AsCsv -or $BlockType -eq 'csv'
        if ($useCsv -and ($items | Where-Object { $_ -isnot [string] }).Count -gt 0) {
            $content = ($items | ConvertTo-Csv -NoTypeInformation) -join [Environment]::NewLine
        }
        else {
            $content = ($items | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
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
            -Uri ('{0}/api/blocks/{1}' -f $Uri.TrimEnd('/'), $Code.ToUpperInvariant()) `
            -Method Put `
            -Headers @{ Authorization = "Bearer $ApiKey" } `
            -ContentType 'application/json; charset=utf-8' `
            -Body ($body | ConvertTo-Json -Depth 5)
    }
}
