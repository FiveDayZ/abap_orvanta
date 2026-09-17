param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$Username,

    [string]$Client = "200",

    [string]$Language = "EN",

    [string]$ResultPath
)

$ErrorActionPreference = "Stop"

function Invoke-HelperCase {
    param(
        [Net.Http.HttpClient]$HttpClient,
        [string]$Uri,
        [string]$Operation,
        [string]$ObjectType,
        [string]$ObjectName
    )

    $escapedOperation = [Security.SecurityElement]::Escape($Operation)
    $escapedObjectType = [Security.SecurityElement]::Escape($ObjectType)
    $escapedObjectName = [Security.SecurityElement]::Escape($ObjectName)
    $envelope = @"
<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <n1:Z_ORVANTA_MCP_EXECUTE xmlns:n1="urn:sap-com:document:sap:rfc:functions">
      <IV_OPERATION>$escapedOperation</IV_OPERATION>
      <IV_OBJECT_TYPE>$escapedObjectType</IV_OBJECT_TYPE>
      <IV_OBJECT_NAME>$escapedObjectName</IV_OBJECT_NAME>
    </n1:Z_ORVANTA_MCP_EXECUTE>
  </soapenv:Body>
</soapenv:Envelope>
"@
    $content = [Net.Http.StringContent]::new($envelope, [Text.Encoding]::UTF8, "text/xml")
    $content.Headers.Add("SOAPAction", "http://www.sap.com/Z_ORVANTA_MCP_EXECUTE")
    $response = $HttpClient.PostAsync($Uri, $content).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    try {
        [xml]$document = $body
    }
    catch {
        $bodyExcerpt = $body -replace "[\r\n]+", " "
        return [pscustomobject]@{
            Operation = $Operation
            ObjectType = $ObjectType
            ObjectName = $ObjectName
            HttpStatus = [int]$response.StatusCode
            ParseError = $_.Exception.GetBaseException().Message
            BodyExcerpt = $bodyExcerpt.Substring(
                0,
                [Math]::Min(2000, $bodyExcerpt.Length)
            )
            ResponseBytes = [Text.Encoding]::UTF8.GetByteCount($body)
        }
    }

    function Read-Value([string]$Name) {
        $node = $document.SelectSingleNode("//*[local-name()='$Name']")
        if ($node) { return $node.InnerText }
        return ""
    }

    return [pscustomobject]@{
        Operation = $Operation
        ObjectType = $ObjectType
        ObjectName = $ObjectName
        HttpStatus = [int]$response.StatusCode
        Status = Read-Value "EV_STATUS"
        Code = Read-Value "EV_CODE"
        Message = Read-Value "EV_MESSAGE"
        Version = Read-Value "EV_VERSION"
        FaultCode = Read-Value "faultcode"
        FaultString = Read-Value "faultstring"
        ResponseBytes = [Text.Encoding]::UTF8.GetByteCount($body)
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
    $uri = "$normalizedBaseUrl/sap/bc/soap/rfc?sap-client=$Client&sap-language=$Language"
    $cases = @(
        @{ Operation = "PING"; ObjectType = ""; ObjectName = "" },
        @{ Operation = "DELETE_STANDARD"; ObjectType = "CLAS"; ObjectName = "CL_GUI_FRONTEND_SERVICES" },
        @{ Operation = "VALIDATE_TARGET"; ObjectType = "CLAS"; ObjectName = "CL_GUI_FRONTEND_SERVICES" },
        @{ Operation = "VALIDATE_TARGET"; ObjectType = "CLAS"; ObjectName = "ZCL_ORVANTA_MCP_CORE" }
    )
    $results = @(
        $cases | ForEach-Object {
            Invoke-HelperCase -HttpClient $httpClient -Uri $uri @_
        }
    )
    if ($results.Where({ $_.HttpStatus -ne 200 -or $_.FaultString }).Count) {
        $exitCode = 2
    }
}
catch {
    $results = @([pscustomobject]@{ Error = $_.Exception.GetBaseException().Message })
    $exitCode = 1
}
finally {
    if ($httpClient) { $httpClient.Dispose() }
    $plainPassword = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    Remove-Variable securePassword -ErrorAction SilentlyContinue
}

$json = $results | ConvertTo-Json -Depth 4
if ($ResultPath) {
    $resolvedResultPath = [IO.Path]::GetFullPath($ResultPath)
    [IO.File]::WriteAllText($resolvedResultPath, $json, [Text.UTF8Encoding]::new($false))
}
Write-Output $json
exit $exitCode
