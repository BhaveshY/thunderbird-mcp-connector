param(
  [bool]$InstallClaudeCodeConfig = $true,
  [bool]$InstallClaudeDesktopConfig = $true,
  [bool]$InstallCodexIfPresent = $true,
  [switch]$SkipDependencyInstall,
  [switch]$SkipTests,
  [switch]$NoLaunchThunderbird
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

function Write-Result {
  param([string]$Message)
  Write-Host "OK  $Message"
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (($machinePath, $userPath) | Where-Object { $_ }) -join ";"
}

function Find-Executable {
  param(
    [string[]]$Names,
    [string[]]$ExtraPaths = @()
  )

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and $command.Source) {
      return $command.Source
    }
  }

  foreach ($path in $ExtraPaths) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      return (Resolve-Path -LiteralPath $path).Path
    }
  }

  return $null
}

function Join-OptionalPath {
  param(
    [string]$Base,
    [string]$Child
  )
  if (-not $Base) {
    return $null
  }
  return Join-Path $Base $Child
}

function Invoke-Checked {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$FailureMessage
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage Exit code: $LASTEXITCODE"
  }
}

function Install-WingetPackage {
  param(
    [string]$PackageId,
    [string]$DisplayName
  )

  if ($SkipDependencyInstall) {
    throw "$DisplayName is missing. Dependency install is disabled for this run."
  }

  $winget = Find-Executable -Names @("winget.exe", "winget")
  if (-not $winget) {
    throw "$DisplayName is missing and winget is not available. Install $DisplayName, then rerun this script."
  }

  Write-Step "Installing $DisplayName with winget"
  & $winget install --id $PackageId --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Silent winget install failed. Retrying without --silent so Windows can show prompts."
    & $winget install --id $PackageId --exact --accept-package-agreements --accept-source-agreements
  }
  if ($LASTEXITCODE -ne 0) {
    throw "winget could not install $DisplayName. Exit code: $LASTEXITCODE"
  }
  Refresh-Path
}

function Find-Node {
  $extra = @(
    (Join-OptionalPath $env:ProgramFiles "nodejs\node.exe"),
    (Join-OptionalPath ${env:ProgramFiles(x86)} "nodejs\node.exe"),
    (Join-OptionalPath $env:LOCALAPPDATA "Programs\nodejs\node.exe")
  )
  return Find-Executable -Names @("node.exe", "node") -ExtraPaths $extra
}

function Find-Npm {
  $extra = @(
    (Join-OptionalPath $env:ProgramFiles "nodejs\npm.cmd"),
    (Join-OptionalPath ${env:ProgramFiles(x86)} "nodejs\npm.cmd"),
    (Join-OptionalPath $env:LOCALAPPDATA "Programs\nodejs\npm.cmd")
  )
  return Find-Executable -Names @("npm.cmd", "npm") -ExtraPaths $extra
}

function Get-NodeMajor {
  param([string]$NodePath)
  try {
    $version = & $NodePath -p "process.versions.node"
    return [int]($version.Split(".")[0])
  } catch {
    return 0
  }
}

function Ensure-Node {
  $node = Find-Node
  if (-not $node -or (Get-NodeMajor $node) -lt 20) {
    Install-WingetPackage -PackageId "OpenJS.NodeJS.LTS" -DisplayName "Node.js 20 or newer"
    $node = Find-Node
  }

  if (-not $node -or (Get-NodeMajor $node) -lt 20) {
    throw "Node.js 20 or newer is required but was not found after installation."
  }

  $npm = Find-Npm
  if (-not $npm) {
    throw "npm was not found after Node.js installation."
  }

  return [pscustomobject]@{ Node = $node; Npm = $npm }
}

function Find-Thunderbird {
  $extra = @(
    (Join-OptionalPath $env:ProgramFiles "Mozilla Thunderbird\thunderbird.exe"),
    (Join-OptionalPath ${env:ProgramFiles(x86)} "Mozilla Thunderbird\thunderbird.exe"),
    (Join-OptionalPath $env:LOCALAPPDATA "Programs\Mozilla Thunderbird\thunderbird.exe")
  )

  $appPathKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\thunderbird.exe"
  if (Test-Path $appPathKey) {
    $registered = $null
    try {
      $registered = (Get-ItemProperty -Path $appPathKey -ErrorAction Stop)."(default)"
    } catch {
      $registered = $null
    }
    if ($registered) {
      $extra += $registered
    }
  }

  return Find-Executable -Names @("thunderbird.exe", "thunderbird") -ExtraPaths $extra
}

function Ensure-Thunderbird {
  $thunderbird = Find-Thunderbird
  if (-not $thunderbird) {
    Install-WingetPackage -PackageId "Mozilla.Thunderbird" -DisplayName "Mozilla Thunderbird"
    $thunderbird = Find-Thunderbird
  }

  if (-not $thunderbird) {
    throw "Mozilla Thunderbird was not found after installation."
  }

  return $thunderbird
}

function Read-IniFile {
  param([string]$Path)
  $sections = @{}
  $current = $null

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith(";") -or $trimmed.StartsWith("#")) {
      continue
    }
    if ($trimmed -match "^\[(.+)\]$") {
      $current = $Matches[1]
      $sections[$current] = @{}
      continue
    }
    if ($current -and $trimmed -match "^([^=]+)=(.*)$") {
      $sections[$current][$Matches[1].Trim()] = $Matches[2].Trim()
    }
  }

  return $sections
}

function Resolve-ThunderbirdProfile {
  param([string]$ThunderbirdExe)

  $root = Join-Path $env:APPDATA "Thunderbird"
  $profilesIni = Join-Path $root "profiles.ini"
  if (-not (Test-Path -LiteralPath $profilesIni)) {
    Write-Step "Creating a default Thunderbird profile"
    Start-Process -FilePath $ThunderbirdExe -ArgumentList @("-CreateProfile", "default") -Wait
  }

  if (-not (Test-Path -LiteralPath $profilesIni)) {
    throw "Thunderbird profile information was not found. Start Thunderbird once, complete first-run setup, then rerun this script."
  }

  $ini = Read-IniFile -Path $profilesIni
  $profilePath = $null
  $isRelative = $true

  foreach ($entry in $ini.GetEnumerator()) {
    if ($entry.Key -like "Install*" -and $entry.Value.ContainsKey("Default")) {
      $profilePath = $entry.Value["Default"]
      $isRelative = $true
      break
    }
  }

  if (-not $profilePath) {
    foreach ($entry in $ini.GetEnumerator()) {
      if ($entry.Key -like "Profile*" -and $entry.Value.ContainsKey("Default") -and $entry.Value["Default"] -eq "1") {
        $profilePath = $entry.Value["Path"]
        $isRelative = -not ($entry.Value.ContainsKey("IsRelative") -and $entry.Value["IsRelative"] -eq "0")
        break
      }
    }
  }

  if (-not $profilePath) {
    foreach ($entry in $ini.GetEnumerator()) {
      if ($entry.Key -like "Profile*" -and $entry.Value.ContainsKey("Path")) {
        $profilePath = $entry.Value["Path"]
        $isRelative = -not ($entry.Value.ContainsKey("IsRelative") -and $entry.Value["IsRelative"] -eq "0")
        break
      }
    }
  }

  if (-not $profilePath) {
    throw "No Thunderbird profile was found in profiles.ini."
  }

  $profilePath = $profilePath.Replace("/", [IO.Path]::DirectorySeparatorChar)
  if ($isRelative -and -not [IO.Path]::IsPathRooted($profilePath)) {
    $profilePath = Join-Path $root $profilePath
  }

  if (-not (Test-Path -LiteralPath $profilePath)) {
    throw "Thunderbird profile path does not exist: $profilePath"
  }

  return (Resolve-Path -LiteralPath $profilePath).Path
}

function Stop-ThunderbirdGracefully {
  $processes = @(Get-Process thunderbird -ErrorAction SilentlyContinue)
  if ($processes.Count -eq 0) {
    return
  }

  Write-Step "Closing Thunderbird so the add-on can be installed"
  foreach ($process in ($processes | Where-Object { $_.MainWindowHandle -ne 0 })) {
    [void]$process.CloseMainWindow()
  }

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Process thunderbird -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }

  if (Get-Process thunderbird -ErrorAction SilentlyContinue) {
    Write-Warning "Thunderbird is still running. If add-on copy fails, close Thunderbird with File > Exit and rerun this script."
  }
}

function Install-ThunderbirdAddon {
  param(
    [string]$ProfilePath,
    [string]$XpiPath
  )

  $extensionsDir = Join-Path $ProfilePath "extensions"
  New-Item -ItemType Directory -Force -Path $extensionsDir | Out-Null

  $target = Join-Path $extensionsDir "thunderbird-mcp@local.xpi"
  $oldPointer = Join-Path $extensionsDir "thunderbird-mcp@local"
  if (Test-Path -LiteralPath $oldPointer) {
    Remove-Item -LiteralPath $oldPointer -Force -Recurse
  }

  try {
    Copy-Item -LiteralPath $XpiPath -Destination $target -Force
  } catch {
    throw "Could not copy the Thunderbird add-on XPI. Close Thunderbird completely and rerun this script. $($_.Exception.Message)"
  }

  return $target
}

function Find-ClaudeCode {
  $paths = @()
  $command = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and $command.Source) {
    $paths += $command.Source
  }

  $roots = @(
    (Join-Path $env:APPDATA "Claude\claude-code"),
    (Join-Path $env:LOCALAPPDATA "Packages")
  )

  if (Test-Path -LiteralPath $roots[0]) {
    $paths += Get-ChildItem -Path $roots[0] -Recurse -Filter claude.exe -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -ExpandProperty FullName
  }

  if (Test-Path -LiteralPath $roots[1]) {
    $paths += Get-ChildItem -Path $roots[1] -Directory -Filter "Claude_*" -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "LocalCache\Roaming\Claude\claude-code" } |
      Where-Object { Test-Path -LiteralPath $_ } |
      ForEach-Object { Get-ChildItem -Path $_ -Recurse -Filter claude.exe -File -ErrorAction SilentlyContinue } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -ExpandProperty FullName
  }

  return @($paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique | Select-Object -First 1)[0]
}

function Configure-ClaudeCode {
  param(
    [string]$ClaudeExe,
    [string]$NodePath,
    [string]$CliPath
  )

  if (-not $ClaudeExe) {
    Write-Warning "Claude Code CLI was not found. The agent can add this MCP later with: claude mcp add --scope user thunderbird-mcp -- `"$NodePath`" `"$CliPath`" mcp"
    return
  }

  Write-Step "Configuring Claude Code MCP"
  & $ClaudeExe mcp remove --scope user thunderbird-mcp | Out-Host
  & $ClaudeExe mcp add --scope user thunderbird-mcp -- $NodePath $CliPath mcp
  if ($LASTEXITCODE -ne 0) {
    throw "Claude Code MCP configuration failed."
  }
  & $ClaudeExe mcp list | Out-Host
}

function Get-ClaudeDesktopConfigPaths {
  $paths = New-Object System.Collections.Generic.List[string]
  $paths.Add((Join-Path $env:APPDATA "Claude\claude_desktop_config.json"))

  if (Test-Path -LiteralPath $env:LOCALAPPDATA) {
    Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "Packages") -Directory -Filter "Claude_*" -ErrorAction SilentlyContinue |
      ForEach-Object {
        $paths.Add((Join-Path $_.FullName "LocalCache\Roaming\Claude\claude_desktop_config.json"))
        $paths.Add((Join-Path $_.FullName "LocalCache\Roaming\Claude-3p\claude_desktop_config.json"))
      }
  }

  return $paths | Select-Object -Unique
}

function Update-ClaudeDesktopConfig {
  param(
    [string]$ConfigPath,
    [string]$NodePath,
    [string]$CliPath
  )

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null
  if (Test-Path -LiteralPath $ConfigPath) {
    $item = Get-Item -LiteralPath $ConfigPath
    if ($item.IsReadOnly) {
      $item.IsReadOnly = $false
    }
    Copy-Item -LiteralPath $ConfigPath -Destination "$ConfigPath.bak-thunderbird-mcp" -Force
    $raw = [IO.File]::ReadAllText($ConfigPath).TrimStart([char]0xfeff)
  } else {
    $raw = "{}"
  }

  if ([string]::IsNullOrWhiteSpace($raw)) {
    $raw = "{}"
  }

  try {
    $config = $raw | ConvertFrom-Json
  } catch {
    Copy-Item -LiteralPath $ConfigPath -Destination "$ConfigPath.invalid-thunderbird-mcp" -Force
    $config = "{}" | ConvertFrom-Json
  }

  $mcpServersProperty = $config.PSObject.Properties["mcpServers"]
  if ($null -eq $mcpServersProperty) {
    $config | Add-Member -MemberType NoteProperty -Name mcpServers -Value ([pscustomobject]@{})
  } elseif ($null -eq $mcpServersProperty.Value -or $mcpServersProperty.Value -isnot [pscustomobject]) {
    $config.mcpServers = [pscustomobject]@{}
  }

  $server = [ordered]@{
    command = $NodePath
    args = @($CliPath, "mcp")
    env = [pscustomobject]@{}
  }

  if ($config.mcpServers.PSObject.Properties.Name -contains "thunderbird") {
    $config.mcpServers.thunderbird = $server
  } else {
    $config.mcpServers | Add-Member -MemberType NoteProperty -Name thunderbird -Value $server
  }

  $json = $config | ConvertTo-Json -Depth 20
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($ConfigPath, $json, $utf8NoBom)
}

function Update-CodexConfig {
  param(
    [string]$NodePath,
    [string]$CliPath
  )

  $configPath = Join-Path $HOME ".codex\config.toml"
  if (-not (Test-Path -LiteralPath $configPath)) {
    return
  }

  Copy-Item -LiteralPath $configPath -Destination "$configPath.bak-thunderbird-mcp" -Force
  $nodeToml = $NodePath.Replace("'", "''")
  $cliToml = $CliPath.Replace("'", "''")
  $block = "[mcp_servers.thunderbird]`r`ncommand = '$nodeToml'`r`nargs = ['$cliToml', 'mcp']`r`n"
  $content = [IO.File]::ReadAllText($configPath)
  $content = [regex]::Replace($content, "(?ms)^\[mcp_servers\.thunderbird\]\s*.*?(?=^\[|\z)", "")
  $content = $content.TrimEnd() + "`r`n`r`n" + $block
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($configPath, $content, $utf8NoBom)
}

function Test-ThunderbirdBridge {
  param(
    [string]$NodePath,
    [string]$RepoRoot
  )

  $statusScript = "import('./dist/host/src/mcp-tools.js').then(async ({callTool}) => { const result = await callTool('status', {}); console.log(JSON.stringify(result)); if (!result.connected) process.exit(2); }).catch((error) => { console.error(error.stack || error.message); process.exit(1); })"
  $folderScript = "import('./dist/host/src/mcp-tools.js').then(async ({callTool}) => callTool('list_folders', { includeSubFolders: false })).then((result) => console.log(JSON.stringify({ accountCount: result.accounts?.length ?? 0 }))).catch((error) => { console.error(error.stack || error.message); process.exit(1); })"

  Push-Location $RepoRoot
  try {
    for ($attempt = 1; $attempt -le 12; $attempt += 1) {
      & $NodePath --input-type=module -e $statusScript
      if ($LASTEXITCODE -eq 0) {
        & $NodePath --input-type=module -e $folderScript
        if ($LASTEXITCODE -eq 0) {
          return $true
        }
      }
      Start-Sleep -Seconds 3
    }
  } finally {
    Pop-Location
  }

  return $false
}

if ($env:OS -ne "Windows_NT") {
  throw "This installer is for Windows only. Use docs/INSTALL.md for other platforms."
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$cliPath = Join-Path $repoRoot "dist\host\src\cli.js"

Write-Step "Preparing dependencies"
$tools = Ensure-Node
$node = $tools.Node
$npm = $tools.Npm
$thunderbird = Ensure-Thunderbird
Write-Result "Node: $node"
Write-Result "npm: $npm"
Write-Result "Thunderbird: $thunderbird"

Write-Step "Installing npm packages and building connector"
Push-Location $repoRoot
try {
  Invoke-Checked -FilePath $npm -Arguments @("install") -FailureMessage "npm install failed."
  Invoke-Checked -FilePath $npm -Arguments @("run", "build") -FailureMessage "npm run build failed."
  if (-not $SkipTests) {
    Invoke-Checked -FilePath $npm -Arguments @("test") -FailureMessage "npm test failed."
  }
  Invoke-Checked -FilePath $npm -Arguments @("run", "package:xpi") -FailureMessage "npm run package:xpi failed."
  Invoke-Checked -FilePath $npm -Arguments @("run", "install-native") -FailureMessage "npm run install-native failed."
} finally {
  Pop-Location
}

$manifest = Get-Content -LiteralPath (Join-Path $repoRoot "addon\manifest.json") -Raw | ConvertFrom-Json
$xpiPath = Join-Path $repoRoot "build\thunderbird-mcp-bridge-$($manifest.version).xpi"
if (-not (Test-Path -LiteralPath $xpiPath)) {
  throw "Expected XPI was not built: $xpiPath"
}

$profile = Resolve-ThunderbirdProfile -ThunderbirdExe $thunderbird
Stop-ThunderbirdGracefully
$installedXpi = Install-ThunderbirdAddon -ProfilePath $profile -XpiPath $xpiPath
Write-Result "Thunderbird add-on staged: $installedXpi"

if ($InstallClaudeCodeConfig) {
  Configure-ClaudeCode -ClaudeExe (Find-ClaudeCode) -NodePath $node -CliPath $cliPath
}

if ($InstallClaudeDesktopConfig) {
  Write-Step "Configuring Claude Desktop JSON if present"
  foreach ($configPath in Get-ClaudeDesktopConfigPaths) {
    if ((Test-Path -LiteralPath $configPath) -or $configPath -like (Join-Path $env:APPDATA "Claude*")) {
      Update-ClaudeDesktopConfig -ConfigPath $configPath -NodePath $node -CliPath $cliPath
      Write-Result "Updated $configPath"
    }
  }
}

if ($InstallCodexIfPresent) {
  Write-Step "Configuring Codex if ~/.codex/config.toml exists"
  Update-CodexConfig -NodePath $node -CliPath $cliPath
}

if (-not $NoLaunchThunderbird) {
  Write-Step "Starting Thunderbird and checking the bridge"
  Start-Process -FilePath $thunderbird | Out-Null
  $bridgeOk = Test-ThunderbirdBridge -NodePath $node -RepoRoot $repoRoot
  if ($bridgeOk) {
    Write-Result "Thunderbird MCP bridge is connected."
  } else {
    Write-Warning "The MCP server is installed, but the Thunderbird bridge did not answer yet. Keep Thunderbird open, ensure the Thunderbird MCP Bridge add-on is enabled, then restart Thunderbird."
  }
}

Write-Host ""
Write-Host "Thunderbird MCP install complete."
Write-Host ""
Write-Host "Next steps for the user:"
Write-Host "1. Keep Thunderbird open and sign in to mail if Thunderbird asks."
Write-Host "2. If Thunderbird shows an add-on permission prompt, approve Thunderbird MCP Bridge."
Write-Host "3. In Claude, ask: Use Thunderbird MCP to check status."
Write-Host "4. The connector reads mail only when you ask. It can create drafts, but it does not send email."
