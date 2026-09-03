param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$Username,

    [string]$Client = "200",

    [string]$Language = "EN",

    [string]$FunctionName = "ZCMCP_FM_1501",

    [string]$ImportParameter = "IV_INPUT",

    [string]$ExportParameter = "EV_OUTPUT",

    [string]$ValidInput = "VALIDATION",

    [string]$ExpectedOutput = "MCP:VALIDATION",

    [string]$ExpectedException = "INVALID_INPUT",

    [string]$ResultPath
)

$ErrorActionPreference = "Stop"

foreach ($name in @($FunctionName, $ImportParameter, $ExportParameter)) {
    if ($name -notmatch '^[A-Z][A-Z0-9_]{0,29}$') {
        throw "Invalid ABAP name: $name"
    }
}

function Invoke-FunctionSoap {
    param(
        [Net.Http.HttpClient]$ClientInstance,
        [string]$Uri,
        [string]$InputValue
    )

    $settings = [Xml.XmlWriterSettings]::new()
    $settings.OmitXmlDeclaration = $false
    $settings.Encoding = [Text.UTF8Encoding]::new($false)
    $builder = [Text.StringBuilder]::new()
    $writer = [Xml.XmlWriter]::Create($builder, $settings)
    try {
        $writer.WriteStartDocument()
        $writer.WriteStartElement(
            "soapenv",
            "Envelope",
            "http://schemas.xmlsoap.org/soap/envelope/"
        )
        $writer.WriteStartElement(
            "soapenv",
            "Body",
            "http://schemas.xmlsoap.org/soap/envelope/"
        )
        $writer.WriteStartElement(
            "n1",
            $FunctionName,
            "urn:sap-com:document:sap:rfc:functions"
        )
        $writer.WriteElementString($ImportParameter, $InputValue)
        $writer.WriteEndElement()
        $writer.WriteEndElement()
        $writer.WriteEndElement()
        $writer.WriteEndDocument()
    }
    finally {
        $writer.Dispose()
    }

    $content = [Net.Http.StringContent]::new(
        $builder.ToString(),
        [Text.Encoding]::UTF8,
        "text/xml"
    )
    $content.Headers.Add(
        "SOAPAction",
        "urn:sap-com:document:sap:rfc:functions:$FunctionName"
    )
    $response = $ClientInstance.PostAsync($Uri, $content).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return [pscustomobject]@{
        Status      = [int]$response.StatusCode
        ContentType = [string]$response.Content.Headers.ContentType
        Body        = $body
    }
}

$securePassword = Read-Host "Password for $Username" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$httpClient = $null
$plainPassword = $null
$exitCode = 0

try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $credential = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes("${Username}:$plainPassword")
    )
    $httpClient = [Net.Http.HttpClient]::new()
    $httpClient.Timeout = [TimeSpan]::FromSeconds(30)
    $httpClient.DefaultRequestHeaders.Authorization =
        [Net.Http.Headers.AuthenticationHeaderValue]::new("Basic", $credential)

    $normalizedBaseUrl = $BaseUrl.TrimEnd("/")
    $soapUri = "$normalizedBaseUrl/sap/bc/soap/rfc?sap-client=$Client&sap-language=$Language"
    $valid = Invoke-FunctionSoap `
        -ClientInstance $httpClient `
        -Uri $soapUri `
        -InputValue $ValidInput
    $invalid = Invoke-FunctionSoap `
        -ClientInstance $httpClient `
        -Uri $soapUri `
        -InputValue ""

    $validFault = $valid.Body -match '(?i)(?:soap-env|soapenv|soap):Fault'
    $validOutput = [regex]::Match(
        $valid.Body,
        "(?is)<(?:\w+:)?$ExportParameter(?:\s[^>]*)?>(.*?)</(?:\w+:)?$ExportParameter>"
    )
    $actualOutput = if ($validOutput.Success) {
        [Net.WebUtility]::HtmlDecode($validOutput.Groups[1].Value)
    }
    else {
        ""
    }
    $invalidFault = $invalid.Body -match '(?i)(?:soap-env|soapenv|soap):Fault'
    $invalidException = $invalid.Body -match [regex]::Escape($ExpectedException)
    $result = [pscustomobject]@{
        FunctionName = $FunctionName
        ValidCall    = [pscustomobject]@{
            Status         = $valid.Status
            ContentType    = $valid.ContentType
            HasSoapFault   = $validFault
            ActualOutput   = $actualOutput
            ExpectedOutput = $ExpectedOutput
            Passed         = $valid.Status -eq 200 -and
                -not $validFault -and
                $actualOutput -eq $ExpectedOutput
        }
        InvalidCall  = [pscustomobject]@{
            Status            = $invalid.Status
            ContentType       = $invalid.ContentType
            HasSoapFault      = $invalidFault
            ExpectedException = $ExpectedException
            HasException      = $invalidException
            Passed            = $invalidException
        }
    }
    if (-not $result.ValidCall.Passed -or -not $result.InvalidCall.Passed) {
        $exitCode = 2
    }
}
catch {
    $result = [pscustomobject]@{
        FunctionName = $FunctionName
        Error        = $_.Exception.GetBaseException().Message
    }
    $exitCode = 1
}
finally {
    if ($httpClient) {
        $httpClient.Dispose()
    }
    $plainPassword = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    Remove-Variable securePassword -ErrorAction SilentlyContinue
}

$json = $result | ConvertTo-Json -Depth 5
if ($ResultPath) {
    $resolvedResultPath = [IO.Path]::GetFullPath($ResultPath)
    [IO.File]::WriteAllText($resolvedResultPath, $json, [Text.UTF8Encoding]::new($false))
}
Write-Output $json
exit $exitCode
