$ErrorActionPreference = 'Stop'

$secureKey = Read-Host -Prompt '请输入 DeepSeek API Key' -AsSecureString
$keyPtr = [IntPtr]::Zero
$plainKey = $null

try {
    $keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr)

    if ([string]::IsNullOrWhiteSpace($plainKey)) {
        throw 'DeepSeek API Key 不能为空'
    }

    [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', $plainKey, 'User')
    $env:DEEPSEEK_API_KEY = $plainKey

    Write-Output 'DeepSeek API Key 已保存'
}
finally {
    if ($keyPtr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr)
    }
    $plainKey = $null
}

