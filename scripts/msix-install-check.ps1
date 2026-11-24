<#
.SYNOPSIS
Installs an MSIX for a check (Store spec, section 4): signs a copy with a throwaway
certificate, installs it, starts the app and checks that it logs its Microsoft Store channel to
the real %APPDATA%, then removes everything. It never touches an already installed copy.

Run it with Windows PowerShell 5.1 (powershell.exe): PowerShell 7 can't load the Appx module
on windows-2022. Keep the file ASCII, which 5.1 reads the same without a byte order mark.
#>
param(
    [Parameter(Mandatory)] [string] $Msix,
    [switch] $CheckRuntime,
    [int] $TimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

function Find-SdkTool([string] $Name) {
    $bin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $tool = Get-ChildItem -Path $bin -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName "x64\$Name" } |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1
    if (-not $tool) { throw "$Name not found under $bin" }
    $tool
}

$Msix = (Resolve-Path $Msix).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("msix-check-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null

# 1. The identity, read from the package itself.
$zip = [IO.Compression.ZipFile]::OpenRead($Msix)
try {
    $entry = $zip.GetEntry('AppxManifest.xml')
    $reader = New-Object IO.StreamReader($entry.Open())
    [xml] $manifest = $reader.ReadToEnd()
    $reader.Dispose()
    $exeEntry = $zip.GetEntry($manifest.Package.Applications.Application.Executable)
    [IO.Compression.ZipFileExtensions]::ExtractToFile($exeEntry, (Join-Path $work 'app.exe'))
} finally { $zip.Dispose() }
$name = $manifest.Package.Identity.Name
$publisher = $manifest.Package.Identity.Publisher
if (Get-AppxPackage -Name $name) {
    throw "$name is already installed; this check never touches an installed copy. Remove it first."
}

# 2. A Store machine may lack the Visual C++ runtime.
if ($CheckRuntime) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $dumpbin = & $vswhere -latest -products * -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe' | Select-Object -First 1
    if (-not $dumpbin) { throw 'dumpbin.exe not found' }
    $imports = & $dumpbin /dependents (Join-Path $work 'app.exe')
    $runtime = $imports | Select-String -Pattern '^\s*(vcruntime|msvcp)\d+\S*\.dll\s*$'
    if ($runtime) { throw "the exe needs the Visual C++ runtime: $($runtime -join ', ')" }
}

$cert = $null
$package = $null
try {
    # 3. Sign a copy with a throwaway certificate that matches the Publisher, made as
    #    Microsoft's "Create a certificate for package signing" page shows (code signing EKU,
    #    end-entity basic constraints).
    $cert = New-SelfSignedCertificate -Type Custom -Subject $publisher -KeyUsage DigitalSignature `
        -FriendlyName 'SkoposIDE MSIX check' -CertStoreLocation Cert:\CurrentUser\My `
        -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}') `
        -NotAfter (Get-Date).AddDays(1)
    $cer = Join-Path $work 'check.cer'
    Export-Certificate -Cert $cert -FilePath $cer | Out-Null
    Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
    $signed = Join-Path $work 'signed.msix'
    Copy-Item $Msix $signed
    & (Find-SdkTool 'signtool.exe') sign /fd SHA256 /sha1 $cert.Thumbprint $signed
    if ($LASTEXITCODE -ne 0) { throw "signtool failed with $LASTEXITCODE" }

    # 4. Install and start it.
    $started = Get-Date
    Add-AppxPackage -Path $signed
    $package = Get-AppxPackage -Name $name
    Start-Process "shell:AppsFolder\$($package.PackageFamilyName)!SkoposIDE"

    # 5. The channel line in a log written after the start, under the real %APPDATA%.
    $logs = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'skopos\SkoposIDE\data\logs'
    $virtual = Join-Path $env:LOCALAPPDATA "Packages\$($package.PackageFamilyName)\LocalCache\Roaming\skopos"
    $deadline = $started.AddSeconds($TimeoutSeconds)
    $found = $false
    while (-not $found -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (Test-Path $virtual) { throw "writes are still virtualized: $virtual exists" }
        if (Test-Path $logs) {
            $found = [bool](Get-ChildItem $logs -Filter 'skopos.*.log' |
                Where-Object { $_.LastWriteTime -ge $started } |
                Select-String -SimpleMatch 'install channel: microsoft-store')
        }
    }
    if (-not $found) { throw "no 'install channel: microsoft-store' line under $logs within $TimeoutSeconds s" }
    Write-Host "MSIX check passed: $name logs its Store channel under $logs"
} finally {
    # 6. Remove everything, also on failure.
    if ($package) {
        Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($package.InstallLocation) } |
            Stop-Process -Force -ErrorAction SilentlyContinue
        Remove-AppxPackage -Package $package.PackageFullName -ErrorAction SilentlyContinue
    }
    if ($cert) {
        Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object Thumbprint -eq $cert.Thumbprint |
            Remove-Item -ErrorAction SilentlyContinue
        Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
    }
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
