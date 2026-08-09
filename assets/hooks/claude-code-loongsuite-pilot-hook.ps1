# Claude Code 在 Windows 上的轻量 Hook wrapper。
#
# `agents.d/claude-code.json` 声明 Stop/SubagentStart/SubagentStop；HookStrategy 将每类事件转换成
# kebab-case 参数，并把下列命令注册到 `~/.claude/settings.json`：
#   powershell -File $PILOT_DATA/hooks/claude-code-loongsuite-pilot-hook.ps1 <subcommand>
#
# Claude Code 每次 Hook 调用都把 payload JSON 写入本脚本 stdin。本脚本不解析业务字段，只负责
# 校验子命令、定位 Node.js，并尽量以原始 UTF-8 字节把 stdin 转交 processor。
#
# stop 会由 processor 增量解析 transcript 并写本地 JSONL；subagent-start/subagent-stop 当前只
# 累积 `state.events`，`exportSession()` 尚未消费它们。无论哪种命令，本 wrapper/processor 都不
# 触发 Collector 的 `entries`；常驻 `ClaudeCodeLogInput` 后续轮询 JSONL 时才会触发。
#
# stdout 是 Claude Hook 响应通道。正常完成或可恢复错误返回 `{}` 并退出 0，诊断走 stderr 或
# 独立 error JSONL，避免采集故障阻塞 Claude Code。

# 非终止错误继续执行；关键步骤另外放在 try/catch 或显式检查中实现 fail-open。
$ErrorActionPreference = "Continue"
# 空 JSON 表示 Hook 不要求 Claude Code 执行任何额外动作。
$EMPTY_RESULT = '{}'

# `$MyInvocation` 指向当前脚本，使用其父目录定位同目录 processor，不依赖调用者 cwd。
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "claude-code-hook-processor.mjs"
$Subcommand = if ($args.Count -gt 0) { $args[0] } else { "unknown" }

# 仅处理当前注册的子命令，未知/旧版命令直接返回空 JSON。
if ($Subcommand -notin @("stop", "subagent-start", "subagent-stop")) {
    Write-Output $EMPTY_RESULT
    exit 0
}

# 写 wrapper 自身的按日 JSONL 诊断。目录创建和追加均包在 try 内，失败会被空 catch 吞掉，
# 避免诊断路径反过来阻断 Claude Code；这里不写采集事件文件。
function Log-Error {
    param([string]$Stage, [string]$Message)
    try {
        # 数据目录优先继承部署时注入的环境变量，否则使用与 Collector 一致的用户默认目录。
        $dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) { $env:LOONGSUITE_PILOT_DATA_DIR }
                   else { Join-Path $env:USERPROFILE ".loongsuite-pilot" }
        $day = (Get-Date -Format "yyyy-MM-dd")
        $dir = Join-Path $dataDir "logs\claude-code\errors"
        # `-Force` 允许目录已经存在，Out-Null 防止目录对象污染 Hook stdout 协议。
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $file = Join-Path $dir "claude-code-error-$day.jsonl"
        $time = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        $escapedMsg = $Message -replace '\\', '\\\\' -replace '"', '\"'
        $line = "{`"time`":`"$time`",`"gen_ai.agent.type`":`"claude-code`",`"stage`":`"$Stage`",`"error.type`":`"ps1_$Stage`",`"error.message`":`"$escapedMsg`"}"
        # Add-Content 追加一条完整行，不覆盖同日已有诊断。
        Add-Content -Path $file -Value $line
    } catch {}
}

# processor 丢失表示 Hook 资产部署不完整；记录后返回空响应，仍不阻塞宿主。
if (-not (Test-Path $Processor)) {
    Write-Error "[claude-code-hook] processor not found: $Processor"
    Log-Error "missing_processor" "hook processor not found: $Processor"
    Write-Output $EMPTY_RESULT
    exit 0
}

# processor 使用 ESM 和当前 Node API，要求 Node.js 18 或更高版本。
$MIN_NODE_MAJOR = 18

# 调用 `node --version` 并解析主版本；重定向 2>$null 防止候选错误污染 Hook stdout。
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

# 从安装器固定 pin、NVM/FNM/Volta、系统目录到 PATH 只读搜索 Node；不修改用户环境。
# 找到首个存在且版本 >=18 的候选即 return，全部不满足时返回 null。
function Resolve-NodeBin {
    $pinFile = Join-Path $env:USERPROFILE ".loongsuite-pilot\node-bin"
    if (Test-Path $pinFile) {
        $pinned = (Get-Content $pinFile -ErrorAction SilentlyContinue).Trim()
        if ($pinned -and (Test-NodeSuitable $pinned)) { return $pinned }
    }

    # 数组保持候选优先级；版本目录按名称降序，通常先试较新版本。
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

    # 每个候选都交给 Test-NodeSuitable，坏路径/坏版本只影响当前候选。
    foreach ($c in $candidates) {
        if (Test-NodeSuitable $c) { return $c }
    }
    return $null
}

# 真正启动 processor 前先解析一次 Node 路径；找不到时走 fail-open。
$nodeBin = Resolve-NodeBin
if (-not $nodeBin) {
    Write-Error "[claude-code-hook] node >= $MIN_NODE_MAJOR not found"
    Log-Error "missing_node" "node >= $MIN_NODE_MAJOR not found"
    Write-Output $EMPTY_RESULT
    exit 0
}

# 未重定向 stdin 通常是人工执行而非 Claude Code Hook；没有 payload 时直接返回。
if (-not [Console]::IsInputRedirected) {
    Write-Output $EMPTY_RESULT
    exit 0
}

try {
    # 先把 stdin 完整复制到内存字节数组，避免 PowerShell 按本机 GB2312/ASCII 文本代码页解码。
    $stdinStream = [Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $stdinStream.CopyTo($ms)
    $rawBytes = $ms.ToArray()
    $ms.Dispose()

    # JSON 前的 UTF-8 BOM（EF BB BF）会影响 processor 解析，因此在编码修复前去掉。
    if ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF) {
        $rawBytes = $rawBytes[3..($rawBytes.Length - 1)]
    }

    # 尝试逆转中文 Windows 管道可能造成的 UTF-8 -> GBK 二次编码。只有恢复结果能通过严格
    # UTF-8 校验时才替换原字节；任何异常都保留原输入，让 processor 自己按 fail-open 解析。
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
        # 空 stdin 无需创建重定向子进程，直接调用 Node；processor 会返回固定 `{}`。
        $result = & $nodeBin $Processor $Subcommand 2>$null
    } else {
        # 非空 payload 使用 ProcessStartInfo 获取标准输入的字节流控制权，避免 PowerShell 管道转码。
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $nodeBin
        $psi.Arguments = "`"$Processor`" $Subcommand"
        # 关闭 ShellExecute 才能重定向 stdin/stdout；stderr 保持连接到宿主诊断通道。
        $psi.UseShellExecute = $false
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $false
        $psi.CreateNoWindow = $true

        # 用 BaseStream 原样写入全部 payload 后关闭 stdin，EOF 会让 processor 的同步读取结束。
        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.StandardInput.BaseStream.Write($rawBytes, 0, $rawBytes.Length)
        $proc.StandardInput.Close()
        # processor 完成异步 Stop 导出后才输出 `{}` 并关闭 stdout；ReadToEnd 因而也等待业务完成。
        $result = $proc.StandardOutput.ReadToEnd()
        $proc.WaitForExit()
    }
    # processor 没有输出时由 wrapper 补 `{}`；Write-Output 是唯一正常 stdout，避免污染 Hook 协议。
    if ($result) { Write-Output $result } else { Write-Output $EMPTY_RESULT }
} catch {
    # 启动、管道或编码步骤异常统一记录并降级为空响应，不向 Claude Code 抛出采集错误。
    Write-Error "[claude-code-hook] processor failed (subcommand=$Subcommand)"
    Log-Error "processor_failed" "hook processor exited non-zero (subcommand=$Subcommand)"
    Write-Output $EMPTY_RESULT
}

# 明确成功退出是 fail-open 边界；JSONL 是否写入成功由 processor 的 state offset 保证可重试。
exit 0
