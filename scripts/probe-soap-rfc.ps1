param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$Username,

    [string]$Client = "200",

    [string]$Language = "EN",

    [string]$ResultPath,

    [string]$ServiceName = "RFC_SYSTEM_INFO",

    [switch]$WsdlOnly,

    [string]$WsdlPath
)

$ErrorActionPreference = "Stop"

$securePassword = Read-Host "Password for $Username" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$httpClient = $null
$plainPassword = $null
$results = @()
$exitCode = 0

try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $credential = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes("${Username}:$plainPassword")
    )

    $httpClient = [Net.Http.HttpClient]::new()
    $httpClient.Timeout = [TimeSpan]::FromSeconds(20)
    $httpClient.DefaultRequestHeaders.Authorization =
        [Net.Http.Headers.AuthenticationHeaderValue]::new("Basic", $credential)

    $normalizedBaseUrl = $BaseUrl.TrimEnd("/")
    $encodedServiceName = [Uri]::EscapeDataString($ServiceName)
    $wsdlUri = "$normalizedBaseUrl/sap/bc/soap/wsdl11?services=$encodedServiceName&sap-client=$Client&sap-language=$Language"
    $wsdlResponse = $httpClient.GetAsync($wsdlUri).GetAwaiter().GetResult()
    $wsdlBody = $wsdlResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if ($WsdlPath) {
        $resolvedWsdlPath = [IO.Path]::GetFullPath($WsdlPath)
        [IO.File]::WriteAllText(
            $resolvedWsdlPath,
            $wsdlBody,
            [Text.UTF8Encoding]::new($false)
        )
    }
    $results += [pscustomobject]@{
        Check          = "WSDL"
        Service        = $ServiceName
        Status         = [int]$wsdlResponse.StatusCode
        ContentType    = [string]$wsdlResponse.Content.Headers.ContentType
        Bytes          = [Text.Encoding]::UTF8.GetByteCount($wsdlBody)
        HasDefinitions = $wsdlBody -match "(?i)<(?:\w+:)?definitions\b"
        HasFunction    = $wsdlBody -match [Regex]::Escape($ServiceName)
    }

    if (-not $WsdlOnly) {
        if ($ServiceName -ne "RFC_SYSTEM_INFO") {
            throw "SOAP invocation is only implemented for RFC_SYSTEM_INFO; use -WsdlOnly for other services"
        }

        $envelope = @"
<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <n1:RFC_SYSTEM_INFO xmlns:n1="urn:sap-com:document:sap:rfc:functions" />
  </soapenv:Body>
</soapenv:Envelope>
"@
        $content = [Net.Http.StringContent]::new(
            $envelope,
            [Text.Encoding]::UTF8,
            "text/xml"
        )
        $content.Headers.Add(
            "SOAPAction",
            "urn:sap-com:document:sap:rfc:functions:RFC_SYSTEM_INFO"
        )
        $soapUri = "$normalizedBaseUrl/sap/bc/soap/rfc?sap-client=$Client&sap-language=$Language"
        $soapResponse = $httpClient.PostAsync($soapUri, $content).GetAwaiter().GetResult()
        $soapBody = $soapResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $hasSoapFault = $soapBody -match "(?i)(?:soap-env|soapenv|soap):Fault"
        $results += [pscustomobject]@{
            Check        = "RFC_SYSTEM_INFO"
            Status       = [int]$soapResponse.StatusCode
            ContentType  = [string]$soapResponse.Content.Headers.ContentType
            Bytes        = [Text.Encoding]::UTF8.GetByteCount($soapBody)
            HasResponse  = $soapBody -match "RFC_SYSTEM_INFO.Response"
            HasSoapFault = $hasSoapFault
        }
    }

    if (-not $wsdlResponse.IsSuccessStatusCode -or
        (-not $WsdlOnly -and
            (-not $soapResponse.IsSuccessStatusCode -or $hasSoapFault))) {
        $exitCode = 2
    }
}
catch {
    $results += [pscustomobject]@{
        Check = "Probe"
        Error = $_.Exception.GetBaseException().Message
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

$json = $results | ConvertTo-Json -Depth 3
if ($ResultPath) {
    $resolvedResultPath = [IO.Path]::GetFullPath($ResultPath)
    [IO.File]::WriteAllText($resolvedResultPath, $json, [Text.UTF8Encoding]::new($false))
}

Write-Output $json
exit $exitCode
