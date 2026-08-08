function New-LambdaNote {
    <#
    .SYNOPSIS
    Posts a new note to Lambda using its static API key.

    .EXAMPLE
    New-LambdaNote -Uri 'https://notes.example.com' -ApiKey $env:LAMBDA_API_KEY `
        -Title 'Restart service' -Category 'PowerShell' -Tags admin,windows `
        -BlockType code -Language powershell -Content 'Restart-Service Spooler'

    .EXAMPLE
    Get-Clipboard | New-LambdaNote -Title 'Clipboard capture' -Category 'Inbox'
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
        [AllowEmptyString()]
        [string] $Content = '',

        [ValidateSet('text', 'heading', 'code')]
        [string] $BlockType = 'text',

        [string] $Language = 'powershell',

        [string] $Uri = $env:LAMBDA_URL,

        [string] $ApiKey = $env:LAMBDA_API_KEY
    )

    begin {
        $contentParts = [System.Collections.Generic.List[string]]::new()
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

        $block = [ordered]@{
            id      = [guid]::NewGuid().ToString()
            type    = $BlockType
            content = $contentParts -join [Environment]::NewLine
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

        $request = @{
            Uri         = '{0}/api/notes' -f $Uri.TrimEnd('/')
            Method      = 'Post'
            Headers     = @{ Authorization = "Bearer $ApiKey" }
            ContentType = 'application/json; charset=utf-8'
            Body        = $body
        }
        Invoke-RestMethod @request
    }
}
