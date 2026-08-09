# Qoder Work Windows Hook 入口：把 stdin JSON 委托给 qoderwork-hook-processor.mjs。
# 调用：powershell -File qoderwork-loongsuite-pilot-hook.ps1；可选首参覆盖 agent-id。
# processor 解析 Qoder Work transcript 并写 history JSONL；缺少 Node/processor 或解析失败时
# 都保持 exit 0，不能阻塞宿主 Agent。

$ErrorActionPreference = "Continue"
$AgentId = if ($args.Count -gt 0) { $args[0] } else { "qoder-work" }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "qoderwork-hook-processor.mjs"

if (-not [Console]::IsInputRedirected) { exit 0 }
if (-not (Test-Path $Processor)) { exit 0 }

$MIN_NODE_MAJOR = 18

# 候选 Node 必须存在且主版本 >=18；catch 将不可执行/输出异常收敛为 false。
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

# 按确定性优先级寻找 node.exe，不修改用户的 PATH、NVM_HOME 或 Pilot pin 文件。
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
    # 按原始字节读取，避免 PowerShell 经 GB2312/ASCII 转码而损坏 UTF-8 JSON。
    $stdinStream = [Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $stdinStream.CopyTo($ms)
    $rawBytes = $ms.ToArray()
    $ms.Dispose()

    # 编码修复前去掉 UTF-8 BOM（EF BB BF）。
    if ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF) {
        $rawBytes = $rawBytes[3..($rawBytes.Length - 1)]
    }

    # 尝试修复中文 Windows 上的 UTF-8 -> GBK 二次编码；失败则保留原字节。
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

        # ProcessStartInfo 允许使用 BaseStream 传递 stdin 字节，避免文本管道损坏非 ASCII JSON。
        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.StandardInput.BaseStream.Write($rawBytes, 0, $rawBytes.Length)
        $proc.StandardInput.Close()
        $null = $proc.StandardOutput.ReadToEnd()
        $proc.WaitForExit()
    }
} catch {}

exit 0
