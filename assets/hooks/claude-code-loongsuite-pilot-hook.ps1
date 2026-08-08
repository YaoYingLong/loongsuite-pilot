# Claude Code Windows Hook 入口：把 stdin JSON 委托给 claude-code-hook-processor.mjs。
#
# HookStrategy 将下列命令注册到 ~/.claude/settings.json：
#   powershell -File $PILOT_DATA/hooks/claude-code-loongsuite-pilot-hook.ps1 <subcommand>
#
# 子命令：stop / subagent-start / subagent-stop。stop 解析 transcript 并写本地 JSONL，
# 子 Agent 事件先保存状态，稍后并入父会话。
#
# fail-open：任何错误都输出 `{}` 并退出 0，不阻塞宿主 Agent。

$ErrorActionPreference = "Continue"
$EMPTY_RESULT = '{}'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "claude-code-hook-processor.mjs"
$Subcommand = if ($args.Count -gt 0) { $args[0] } else { "unknown" }

# 仅处理当前注册的子命令，未知/旧版命令直接返回空 JSON。
if ($Subcommand -notin @("stop", "subagent-start", "subagent-stop")) {
    Write-Output $EMPTY_RESULT
    exit 0
}

function Log-Error {
    param([string]$Stage, [string]$Message)
    try {
        $dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) { $env:LOONGSUITE_PILOT_DATA_DIR }
                   else { Join-Path $env:USERPROFILE ".loongsuite-pilot" }
        $day = (Get-Date -Format "yyyy-MM-dd")
        $dir = Join-Path $dataDir "logs\claude-code\errors"
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $file = Join-Path $dir "claude-code-error-$day.jsonl"
        $time = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        $escapedMsg = $Message -replace '\\', '\\\\' -replace '"', '\"'
        $line = "{`"time`":`"$time`",`"gen_ai.agent.type`":`"claude-code`",`"stage`":`"$Stage`",`"error.type`":`"ps1_$Stage`",`"error.message`":`"$escapedMsg`"}"
        Add-Content -Path $file -Value $line
    } catch {}
}

if (-not (Test-Path $Processor)) {
    Write-Error "[claude-code-hook] processor not found: $Processor"
    Log-Error "missing_processor" "hook processor not found: $Processor"
    Write-Output $EMPTY_RESULT
    exit 0
}

$MIN_NODE_MAJOR = 18

function Test-NodeSuitable {
    param([string]$bin)
    if (-not (Test-Path $bin)) { return $false }
    try {
        $ver = & $bin --version 2>$null
        if (-not $ver) { return $false }
        $major = [int]($ver -replace '^v','').Split('.')[0]
        return $major -ge $MIN_NODE_MAJOR
    } catch { return $false }
}

function Resolve-NodeBin {
    $pinFile = Join-Path $env:USERPROFILE ".loongsuite-pilot\node-bin"
    if (Test-Path $pinFile) {
        $pinned = (Get-Content $pinFile -ErrorAction SilentlyContinue).Trim()
        if ($pinned -and (Test-NodeSuitable $pinned)) { return $pinned }
    }

    $candidates = @()
    $nvmHome = $env:NVM_HOME
    if ($nvmHome -and (Test-Path $nvmHome)) {
        $nvmDirs = Get-ChildItem $nvmHome -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
        foreach ($d in $nvmDirs) { $candidates += Join-Path $d.FullName "node.exe" }
    }
    $fnmDir = Join-Path $env:USERPROFILE ".fnm\node-versions"
    if (Test-Path $fnmDir) {
        $fnmDirs = Get-ChildItem $fnmDir -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
        foreach ($d in $fnmDirs) { $candidates += Join-Path $d.FullName "installation\node.exe" }
    }
    $candidates += Join-Path $env:USERPROFILE ".volta\bin\node.exe"
    $candidates += "C:\Program Files\nodejs\node.exe"
    $candidates += "C:\Program Files (x86)\nodejs\node.exe"
    $pathNode = Get-Command node -ErrorAction SilentlyContinue
    if ($pathNode) { $candidates += $pathNode.Source }

    foreach ($c in $candidates) {
        if (Test-NodeSuitable $c) { return $c }
    }
    return $null
}

$nodeBin = Resolve-NodeBin
if (-not $nodeBin) {
    Write-Error "[claude-code-hook] node >= $MIN_NODE_MAJOR not found"
    Log-Error "missing_node" "node >= $MIN_NODE_MAJOR not found"
    Write-Output $EMPTY_RESULT
    exit 0
}

if (-not [Console]::IsInputRedirected) {
    Write-Output $EMPTY_RESULT
    exit 0
}

try {
    # 以原始字节读取 stdin，避免 PowerShell 通过 GB2312/ASCII 破坏 UTF-8。
    $stdinStream = [Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $stdinStream.CopyTo($ms)
    $rawBytes = $ms.ToArray()
    $ms.Dispose()

    # 编码修复前去掉 UTF-8 BOM（EF BB BF）。
    if ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF) {
        $rawBytes = $rawBytes[3..($rawBytes.Length - 1)]
    }

    # 尝试逆转中文 Windows 上的 UTF-8 -> GBK 二次编码；校验失败时保留原字节。
    if ($rawBytes.Length -gt 2) {
        try {
            $utf8    = [System.Text.Encoding]::UTF8
            $gbk     = [System.Text.Encoding]::GetEncoding(936)
            $garbled = $utf8.GetString($rawBytes)
            $recovered = $gbk.GetBytes($garbled)

            $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
            [void]$strictUtf8.GetString($recovered)

            $rawBytes = $recovered
        } catch {}
    }

    if ($rawBytes.Length -eq 0) {
        $result = & $nodeBin $Processor $Subcommand 2>$null
    } else {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $nodeBin
        $psi.Arguments = "`"$Processor`" $Subcommand"
        $psi.UseShellExecute = $false
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $false
        $psi.CreateNoWindow = $true

        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.StandardInput.BaseStream.Write($rawBytes, 0, $rawBytes.Length)
        $proc.StandardInput.Close()
        $result = $proc.StandardOutput.ReadToEnd()
        $proc.WaitForExit()
    }
    if ($result) { Write-Output $result } else { Write-Output $EMPTY_RESULT }
} catch {
    Write-Error "[claude-code-hook] processor failed (subcommand=$Subcommand)"
    Log-Error "processor_failed" "hook processor exited non-zero (subcommand=$Subcommand)"
    Write-Output $EMPTY_RESULT
}

exit 0
