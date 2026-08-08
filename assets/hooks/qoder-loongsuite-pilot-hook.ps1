# Qoder Windows Hook 入口：把 stdin JSON 委托给 qoder-hook-processor.mjs。
# 调用：powershell -File qoder-loongsuite-pilot-hook.ps1 [agent-id]；agent-id 默认 `qoder`。
# 安装后 HookManager 将本命令写入 Qoder 配置。processor 增量读取 transcript 并把记录写入
# logs/<agent-id>/history/*.jsonl。所有异常均收敛为 exit 0，避免遥测影响宿主 Agent。
# `$ErrorActionPreference = Continue` 让非终止错误可由后续检查处理，而非中断整个 Hook。

$ErrorActionPreference = "Continue"
$AgentId = if ($args.Count -gt 0) { $args[0] } else { "qoder" }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "qoder-hook-processor.mjs"

if (-not [Console]::IsInputRedirected) { exit 0 }
if (-not (Test-Path $Processor)) { exit 0 }

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
    Write-Error "[loongsuite-pilot] node >= $MIN_NODE_MAJOR not found"
    exit 0
}

try {
    # 按原始字节读取 stdin，避免 PowerShell 文本管道以 GB2312/ASCII 破坏 UTF-8。
    $stdinStream = [Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $stdinStream.CopyTo($ms)
    $rawBytes = $ms.ToArray()
    $ms.Dispose()

    # 编码修复前先去掉 UTF-8 BOM（EF BB BF），否则 Node 无法直接 JSON.parse。
    if ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF) {
        $rawBytes = $rawBytes[3..($rawBytes.Length - 1)]
    }

    # 修复 Cursor 在中文 Windows 上造成的 UTF-8 -> GBK 二次编码。Cursor 经系统代码页
    #（GBK/CP936）传递 payload 时会损坏非 ASCII 文本；逆向过程先按 UTF-8 解码乱码，
    # 再按 GBK 编码以恢复原始 UTF-8 字节。恢复结果必须通过严格 UTF-8 校验。
    if ($rawBytes.Length -gt 2) {
        try {
            $utf8    = [System.Text.Encoding]::UTF8
            $gbk     = [System.Text.Encoding]::GetEncoding(936)
            $garbled = $utf8.GetString($rawBytes)
            $recovered = $gbk.GetBytes($garbled)

            $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
            [void]$strictUtf8.GetString($recovered)

            $rawBytes = $recovered
        } catch {
            # 校验失败通常说明原字节本来就是正确 UTF-8，因此保持原值。
        }
    }

    if ($rawBytes.Length -eq 0) {
        & $nodeBin $Processor --agent-id $AgentId 2>$null
    } else {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $nodeBin
        $psi.Arguments = "`"$Processor`" --agent-id $AgentId"
        $psi.UseShellExecute = $false
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $false
        $psi.CreateNoWindow = $true

        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.StandardInput.BaseStream.Write($rawBytes, 0, $rawBytes.Length)
        $proc.StandardInput.Close()
        $null = $proc.StandardOutput.ReadToEnd()
        $proc.WaitForExit()
    }
} catch {}

exit 0
