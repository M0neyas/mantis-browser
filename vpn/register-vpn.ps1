# Jednorázová registrace VPN pomocníka pro Mantis Browser.
# Spustit jednou po rozbalení prohlížeče (bez práv správce):
#   pravý klik na register-vpn.ps1 → Spustit pomocí PowerShellu
# Zapíše do registru (HKCU) cestu k mantis-vpn.exe, aby ho prohlížeč našel.
# Po přesunutí složky s prohlížečem spustit znovu. Odregistrace: -Remove

param([switch]$Remove)

$name = "cz.mantis.vpn"
$key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$name"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Join-Path $here "$name.json"

if ($Remove) {
    Remove-Item $key -ErrorAction SilentlyContinue
    Remove-Item $manifest -ErrorAction SilentlyContinue
    Write-Host "VPN pomocnik odregistrovan."
    return
}

$exe = Join-Path $here "mantis-vpn.exe"
if (-not (Test-Path $exe)) { throw "Vedle skriptu chybi mantis-vpn.exe" }
if (-not (Test-Path (Join-Path $here "wireproxy.exe"))) { throw "Vedle skriptu chybi wireproxy.exe" }

@{
    name               = $name
    description        = "Mantis Browser VPN (WireGuard pres wireproxy)"
    path               = $exe
    type               = "stdio"
    allowed_extensions = @("mantis@mantis.browser")
} | ConvertTo-Json | ForEach-Object {
    # UTF-8 bez BOM (cesta může obsahovat diakritiku)
    [IO.File]::WriteAllText($manifest, $_, (New-Object Text.UTF8Encoding $false))
}

New-Item $key -Force | Out-Null
Set-Item $key -Value $manifest

Write-Host "VPN pomocnik zaregistrovan: $manifest"
Write-Host "Restartujte Mantis Browser a kliknete na tlacitko VPN ve spodni liste."
