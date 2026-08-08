# loongsuite-pilot Windows 服务管理入口。
# 安装器将它复制到用户 PATH，并由 `.cmd` shim 转发。它使用 Task Scheduler 实现登录自启和
# 5 分钟 watchdog，最终执行稳定 `collector-daemon.js`，与 macOS launchd/Linux systemd 的职责对应。
#
# 用法：
#   loongsuite-pilot start
#   loongsuite-pilot stop
#   loongsuite-pilot restart
#   loongsuite-pilot status
#   loongsuite-pilot info
#   loongsuite-pilot rollback
#   loongsuite-pilot help
#
# start/register 可能创建 Scheduled Task 和隐藏窗口 VBScript；stop 会停止任务、PID 进程和遗留进程。
# `$ErrorActionPreference = "Stop"` 让 cmdlet 的非终止错误也进入 catch/顶层失败处理。

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = "status",

    [Parameter(Position = 1, ValueFromRemainingArguments)]
    [string[]]$SubArgs
)

$ErrorActionPreference = "Stop"

# ============================================================
# 常量与路径
# ============================================================
$CACHE_DIR = Join-Path $env:USERPROFILE ".loongsuite-pilot"
$DATA_DIR = if ($env:LOONGSUITE_PILOT_DATA_DIR) { $env:LOONGSUITE_PILOT_DATA_DIR } else { $CACHE_DIR }
$VERSIONS_DIR = Join-Path $CACHE_DIR "versions"
$CURRENT_FILE = Join-Path $CACHE_DIR "current"
$PREVIOUS_FILE = Join-Path $CACHE_DIR "previous"
$BOOTSTRAP_DIR = Join-Path $CACHE_DIR "bin"
$PACKAGE_DIR = Join-Path $CACHE_DIR "package"
$PID_FILE = Join-Path $DATA_DIR "loongsuite-pilot.pid"
$UPDATER_PID_FILE = Join-Path $DATA_DIR "loongsuite-pilot-updater.pid"
$LOG_DIR = Join-Path $DATA_DIR "logs"
$LOG_FILE = Join-Path $LOG_DIR "loongsuite-pilot-service.log"
$UPDATER_LOG_FILE = Join-Path $LOG_DIR "loongsuite-pilot-updater.log"
$CONFIG_FILE = Join-Path $DATA_DIR "config.json"
$SPAN_ATTR_FILE = Join-Path $DATA_DIR "span-attributes.json"
$NODE_PIN_FILE = Join-Path $CACHE_DIR "node-bin"
$INIT_TYPE_FILE = Join-Path $DATA_DIR "init-type"

# Task 名按用户隔离：同机用户各自使用 %USERPROFILE% 数据目录；全局 Task 名会导致第二个用户
# 无法覆盖首个用户的 Task。共享 \LoongsuitePilot 文件夹仍允许跨用户访问，只有 Task 名附带
# `whoami` 的 DOMAIN\user 标签；不能只用 `$env:USERNAME`，否则不同域的同名账户仍会冲突。
$USER_TAG = ((whoami) -replace '[^A-Za-z0-9._-]', '_')
$TASK_NAME_COLLECTOR = "LoongsuitePilot-$USER_TAG"
$TASK_NAME_UPDATER = "LoongsuitePilotUpdater-$USER_TAG"
$TASK_FOLDER = "\LoongsuitePilot"

# 旧版本使用全局 Task 名；start 时会 best-effort 清理，权限不足则保留。
$LEGACY_TASK_NAMES = @("LoongsuitePilot", "LoongsuitePilotUpdater")

$LOONGSUITE_PILOT_BIN = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.cmd"

# ============================================================
# 通用辅助函数
# ============================================================
# 创建数据、日志、版本和稳定 bin 目录，已存在时保持幂等。
function Ensure-Dirs {
    @($LOG_DIR, $BOOTSTRAP_DIR) | ForEach-Object {
        if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
    }
}

# 执行候选 node --version，确认存在且主版本不低于 18。
function Test-NodeSuitable {
    param([string]$bin)
    if (-not $bin -or -not (Test-Path $bin)) { return $false }
    try {
        $ver = & $bin --version 2>$null
        if (-not $ver) { return $false }
        $major = [int]($ver -replace '^v','').Split('.')[0]
        return $major -ge 18
    } catch { return $false }
}

# 按 node-bin、nvm-windows、fnm、Volta、Program Files 和 PATH 解析可用 Node，并更新 pin。
function Resolve-Node {
    # 1. 优先读取安装器固定的 Node 路径。
    if (Test-Path $NODE_PIN_FILE) {
        $pinned = (Get-Content $NODE_PIN_FILE -ErrorAction SilentlyContinue).Trim()
        if ($pinned -and (Test-NodeSuitable $pinned)) {
            return $pinned
        }
    }

    # 2. pin 无效时依次搜索常见安装来源。
    $candidates = @()

    # nvm-windows
    if ($env:NVM_HOME -and (Test-Path $env:NVM_HOME)) {
        Get-ChildItem $env:NVM_HOME -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { $candidates += Join-Path $_.FullName "node.exe" }
    }

    # fnm
    $fnmDir = Join-Path $env:USERPROFILE ".fnm\node-versions"
    if (Test-Path $fnmDir) {
        Get-ChildItem $fnmDir -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { $candidates += Join-Path $_.FullName "installation\node.exe" }
    }

    # Volta 与标准安装路径。
    $candidates += Join-Path $env:USERPROFILE ".volta\bin\node.exe"
    $candidates += "C:\Program Files\nodejs\node.exe"
    $candidates += "C:\Program Files (x86)\nodejs\node.exe"

    # 最后查询当前 PATH。
    $pathNode = Get-Command node -ErrorAction SilentlyContinue
    if ($pathNode) { $candidates += $pathNode.Source }

    foreach ($c in $candidates) {
        if (Test-NodeSuitable $c) {
            # 找到可用 Node 后自动修复 node-bin，供后台任务稳定复用。
            $parentDir = Split-Path $NODE_PIN_FILE
            if (-not (Test-Path $parentDir)) { New-Item -ItemType Directory -Path $parentDir -Force | Out-Null }
            Set-Content -Path $NODE_PIN_FILE -Value $c
            return $c
        }
    }
    return $null
}

# 从 current 版本复制 Collector/Updater daemon 到稳定 bin 目录。
function Sync-BootstrapScripts {
    $versionDir = Resolve-CurrentVersion
    if (-not $versionDir) { return }
    $srcDir = Join-Path $versionDir "scripts"
    $collectorSrc = Join-Path $srcDir "collector-daemon.js"
    if (-not (Test-Path $collectorSrc)) { return }
    if (-not (Test-Path $BOOTSTRAP_DIR)) { New-Item -ItemType Directory -Path $BOOTSTRAP_DIR -Force | Out-Null }
    Copy-Item $collectorSrc $BOOTSTRAP_DIR -Force
    $updaterSrc = Join-Path $srcDir "updater-daemon.js"
    if (Test-Path $updaterSrc) { Copy-Item $updaterSrc $BOOTSTRAP_DIR -Force }
}

# 从指定版本同步 CLI 与稳定 daemon，供升级和回滚后修复入口。
function Sync-InstalledScriptsFromVersion {
    param([string]$versionDir)
    $srcDir = Join-Path $versionDir "scripts"
    $required = @("collector-daemon.js", "updater-daemon.js")
    foreach ($f in $required) {
        if (-not (Test-Path (Join-Path $srcDir $f))) { return $false }
    }

    if (-not (Test-Path $BOOTSTRAP_DIR)) { New-Item -ItemType Directory -Path $BOOTSTRAP_DIR -Force | Out-Null }
    foreach ($f in $required) {
        $tmp = Join-Path $BOOTSTRAP_DIR "$f.tmp"
        Copy-Item (Join-Path $srcDir $f) $tmp -Force
        Move-Item $tmp (Join-Path $BOOTSTRAP_DIR $f) -Force
    }
    return $true
}

# ============================================================
# 版本指针解析
# ============================================================
# 读取 current 并验证目录；无新布局时回退旧 package 目录。
function Resolve-CurrentVersion {
    if (Test-Path $CURRENT_FILE) {
        $dir = (Get-Content $CURRENT_FILE -ErrorAction SilentlyContinue).Trim()
        $path = Join-Path $VERSIONS_DIR $dir
        if ($dir -and (Test-Path $path)) { return $path }
    }
    $indexJs = Join-Path $PACKAGE_DIR "dist\index.js"
    if (Test-Path $indexJs) { return $PACKAGE_DIR }
    return $null
}

# 读取 previous 并验证对应版本目录，供 rollback 使用。
function Resolve-PreviousVersion {
    if (Test-Path $PREVIOUS_FILE) {
        $dir = (Get-Content $PREVIOUS_FILE -ErrorAction SilentlyContinue).Trim()
        $path = Join-Path $VERSIONS_DIR $dir
        if ($dir -and (Test-Path $path)) { return $path }
    }
    return $null
}

# 读取并返回/展示 Get-VersionInfo 对应信息，不改变服务运行状态。
function Get-VersionInfo {
    param([string]$dir)
    $vf = Join-Path $dir "VERSION"
    $info = @{ version = ""; git_commit = ""; build_time = "" }
    if (Test-Path $vf) {
        Get-Content $vf | ForEach-Object {
            if ($_ -match "^(\w+)=(.+)$") {
                $info[$Matches[1]] = $Matches[2]
            }
        }
    }
    return $info
}

# 读取并返回/展示 Show-VersionString 对应信息，不改变服务运行状态。
function Show-VersionString {
    param([string]$dir)
    $info = Get-VersionInfo $dir
    if ($info.version) {
        return "v$($info.version) ($($info.git_commit), $($info.build_time))"
    }
    return "unknown"
}

# ============================================================
# 进程管理
# ============================================================
# 用 Get-Process 检查正整数 PID 是否仍存在，不终止进程。
function Test-PidRunning {
    param([string]$pidFile)
    if (-not (Test-Path $pidFile)) { return $false }
    $pidVal = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim()
    if (-not $pidVal) {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        return $false
    }
    $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
    if ($proc) { return $true }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    return $false
}

# 读取 PID 文件后先正常 Stop-Process，等待后必要时 Force，并删除状态文件。
function Stop-PidFile {
    param([string]$pidFile)
    if (-not (Test-PidRunning $pidFile)) {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        return
    }
    $pidVal = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim()
    try { Stop-Process -Id $pidVal -ErrorAction SilentlyContinue } catch {}
    $count = 0
    while ($count -lt 10) {
        $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
        if (-not $proc) { break }
        Start-Sleep -Seconds 1
        $count++
    }
    # 等待后仍存活才强制终止。
    try { Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue } catch {}
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# 按命令行匹配只清理当前用户数据目录对应的遗留 daemon。
function Stop-OrphanProcesses {
    Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                $cmdLine -match "collector-daemon" -or $cmdLine -match "updater-daemon"
            } catch { $false }
        } | ForEach-Object {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
}

# ============================================================
# Task Scheduler 管理
# ============================================================
# 读取并返回/展示 Get-TaskExists 对应信息，不改变服务运行状态。
function Get-TaskExists {
    param([string]$taskName)
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    return $null -ne $task
}

# 读取并返回/展示 Get-TaskRunning 对应信息，不改变服务运行状态。
function Get-TaskRunning {
    param([string]$taskName)
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    if (-not $task) { return $false }
    return $task.State -eq "Running"
}

# 注册 Task 时优先使用 S4U：它无需保存密码，RDP/SSH 断开后仍能以用户身份运行，但要求
# “Log on as a batch job”权限，普通用户通常会收到 0x80070005。此时清理失败尝试留下的条目，
# 再回退 Interactive principal；Interactive 无需该权限，仍可在登录时自启。
# 优先 S4U 注册 Scheduled Task，权限不足时清理半成品并回退 Interactive principal。
function Register-PilotTask {
    param(
        [string]$taskName,
        $action,
        $triggers,
        $settings,
        [string]$description
    )
    $userId = whoami
    $lastErr = $null
    foreach ($logonType in @("S4U", "Interactive")) {
        # 先清理上次失败留下的 Task；S4U 注册可能在 principal 报错前已创建条目，
        # 若不删除会让后续 Interactive 重试因“已存在”再次失败。
        # 因此每种 principal 尝试前都从干净状态开始。
        try { schtasks.exe /Delete /TN "$TASK_FOLDER\$taskName" /F 2>$null | Out-Null } catch {}
        try {
            # 记录 Task 定义在磁盘上的绝对路径，便于错误诊断。
            $diskPath = "$env:SystemRoot\System32\Tasks$TASK_FOLDER\$taskName"
            Write-Host "   Registering '$taskName' (user=$userId, logon=$logonType, path=$diskPath)..."
            $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType $logonType -RunLevel Limited
            Register-ScheduledTask `
                -TaskName $taskName `
                -TaskPath "$TASK_FOLDER\" `
                -Action $action `
                -Trigger $triggers `
                -Settings $settings `
                -Principal $principal `
                -Description $description `
                -ErrorAction Stop | Out-Null
            Write-Host "   Registered '$taskName' with logon type $logonType" -ForegroundColor Green
            return $true
        } catch {
            $lastErr = $_
            # 记录每次尝试及 HRESULT，明确是哪一种 logon type 失败，
            # 而不是只保留最终抛给调用者的异常。
            $hr = ""
            if ($_.Exception -and $null -ne $_.Exception.HResult) {
                $hr = " (HRESULT 0x{0:X8})" -f $_.Exception.HResult
            }
            Write-Host "   $logonType registration failed$hr : $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    throw $lastErr
}

# 构造完全隐藏 Node 控制台的 VBScript Task action。Interactive Task 位于用户桌面会话，
# 即使 PowerShell 使用 `-WindowStyle Hidden` 仍可能闪现控制台；wscript.exe 属于 GUI 子系统，
# 自身没有控制台，并通过 `WshShell.Run(cmd, 0, True)` 隐藏启动且等待 Node，既让 Task 保持
# Running/watchdog 有效，也没有可被误关的窗口。路径直接烘焙进 .vbs，避免 Task+wscript 多层传参引号问题。
# 生成 UTF-16 VBScript 和 wscript Task action，以隐藏控制台并等待 Node 子进程。
function New-HiddenTaskAction {
    param([string]$vbsPath, [string]$nodeBin, [string]$entry)
    # 对嵌入引号做双写，防止路径提前终止 VBScript 字符串；
    # Windows 常规路径虽然不能含引号，但数据目录来自用户环境变量，仍做防御处理。
    # CONFIG_FILE/CACHE_DIR 都可能受 LOONGSUITE_PILOT_DATA_DIR 影响。
    $cfgEsc   = $CONFIG_FILE -replace '"', '""'
    $cwdEsc   = $CACHE_DIR   -replace '"', '""'
    $nodeEsc  = $nodeBin     -replace '"', '""'
    $entryEsc = $entry       -replace '"', '""'
    $vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS").Item("AGENT_DATA_COLLECTION_CONFIG") = "$cfgEsc"
sh.CurrentDirectory = "$cwdEsc"
sh.Run """$nodeEsc"" ""$entryEsc""", 0, True
"@
    # 使用带 BOM 的 UTF-16 LE：wscript 会把无 BOM 的 .vbs 当作系统 ANSI，
    # 而 `-Encoding Default` 在 Windows PowerShell 5.1 是 ANSI、在 PowerShell 7+ 是 UTF-8。
    # 固定 Unicode 可避免中文等非 ASCII 用户目录乱码导致 daemon 无法启动。
    # BOM 能让不同 PowerShell 版本与系统 code page 都正确识别编码。
    # 因此这里不能改用依赖系统区域设置的默认编码。
    Set-Content -Path $vbsPath -Value $vbs -Encoding Unicode
    return (New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`"" -WorkingDirectory $CACHE_DIR)
}

# 注册登录触发和 5 分钟 watchdog 的 Collector 任务，IgnoreNew 防止重复实例。
function Install-CollectorTask {
    param([string]$nodeBin)
    $entry = Join-Path $BOOTSTRAP_DIR "collector-daemon.js"
    if (-not (Test-Path $entry)) {
        Write-Host "Bootstrap script missing: $entry"
        return $false
    }

    $action = New-HiddenTaskAction (Join-Path $BOOTSTRAP_DIR "collector-launch.vbs") $nodeBin $entry

    # 登录触发器负责首启，另一个每 5 分钟重复触发作为 watchdog；
    # 进程崩溃/被杀后 watchdog 会重新拉起。
    # `MultipleInstances=IgnoreNew` 保证正常运行时不会创建第二实例。
    # `-User` 把登录触发限制到当前用户；不指定会对所有用户触发，
    # 这需要管理员权限，普通用户注册时会收到 0x80070005。
    # 因此不能省略当前用户作用域。
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User (whoami)
    $triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 5)

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -DontStopOnIdleEnd `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)

    # 注册前先用 schtasks 删除旧 Task；在兼容环境中它比 Unregister-ScheduledTask 更可靠。
    # `$ErrorActionPreference=Stop` 会把 schtasks stderr 转为异常，因此显式 catch。
    try { schtasks.exe /Delete /TN "$TASK_FOLDER\$TASK_NAME_COLLECTOR" /F 2>$null | Out-Null } catch {}
    try { schtasks.exe /Delete /TN "$TASK_NAME_COLLECTOR" /F 2>$null | Out-Null } catch {}

    return (Register-PilotTask `
        -taskName $TASK_NAME_COLLECTOR `
        -action $action `
        -triggers @($triggerLogon, $triggerRepeat) `
        -settings $settings `
        -description "LoongSuite Pilot data collector")
}

# 仅在稳定 updater daemon 存在时注册独立 Updater Scheduled Task。
function Install-UpdaterTask {
    param([string]$nodeBin)
    $entry = Join-Path $BOOTSTRAP_DIR "updater-daemon.js"
    if (-not (Test-Path $entry)) { return $false }

    $action = New-HiddenTaskAction (Join-Path $BOOTSTRAP_DIR "updater-launch.vbs") $nodeBin $entry

    # `-User` 把登录触发器限制到当前用户；全用户触发需要管理员权限。
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User (whoami)
    $triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 5)

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -DontStopOnIdleEnd `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 5) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)

    try { schtasks.exe /Delete /TN "$TASK_FOLDER\$TASK_NAME_UPDATER" /F 2>$null | Out-Null } catch {}
    try { schtasks.exe /Delete /TN "$TASK_NAME_UPDATER" /F 2>$null | Out-Null } catch {}

    return (Register-PilotTask `
        -taskName $TASK_NAME_UPDATER `
        -action $action `
        -triggers @($triggerLogon, $triggerRepeat) `
        -settings $settings `
        -description "LoongSuite Pilot auto-updater")
}

# 停止并注销当前用户及可清理的旧全局任务，同时删除隐藏 VBScript。
function Remove-AllTasks {
    foreach ($name in @($TASK_NAME_UPDATER, $TASK_NAME_COLLECTOR)) {
        $task = Get-ScheduledTask -TaskName $name -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
        if ($task) {
            if ($task.State -eq "Running") {
                Stop-ScheduledTask -TaskName $name -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
            }
        }
        try { schtasks.exe /Delete /TN "$TASK_FOLDER\$name" /F 2>$null | Out-Null } catch {}
        try { schtasks.exe /Delete /TN "$name" /F 2>$null | Out-Null } catch {}
    }
    # 注销 Task 后同时删除 New-HiddenTaskAction 生成的隐藏启动脚本，
    # 避免稳定 bin 目录遗留无主 VBScript。
    foreach ($vbs in @("collector-launch.vbs", "updater-launch.vbs")) {
        Remove-Item (Join-Path $BOOTSTRAP_DIR $vbs) -Force -ErrorAction SilentlyContinue
    }
}

# ============================================================
# 命令：run（Task Scheduler 调用的前台入口）
# ============================================================
# 写 PID/配置环境后以前台方式启动 Collector daemon，供 Scheduled Task 调用。
function Cmd-Run {
    Ensure-Dirs
    Sync-BootstrapScripts

    $entry = Join-Path $BOOTSTRAP_DIR "collector-daemon.js"
    if (-not (Test-Path $entry)) {
        Write-Error "Bootstrap script missing"
        exit 1
    }

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }

    Set-Content -Path $PID_FILE -Value $PID
    $env:AGENT_DATA_COLLECTION_CONFIG = $CONFIG_FILE
    & $nodeBin $entry
}

# 写 Updater PID 后以前台方式启动 updater-daemon.js。
function Cmd-RunUpdater {
    Ensure-Dirs
    Sync-BootstrapScripts

    $entry = Join-Path $BOOTSTRAP_DIR "updater-daemon.js"
    if (-not (Test-Path $entry)) {
        Write-Error "Bootstrap script missing"
        exit 1
    }

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }

    Set-Content -Path $UPDATER_PID_FILE -Value $PID
    $env:AGENT_DATA_COLLECTION_CONFIG = $CONFIG_FILE
    & $nodeBin $entry
}

# ============================================================
# 命令：start
# ============================================================
# 同步入口、注册任务并启动 Collector/Updater；任务注册失败不会启动不可管理的重复进程。
function Cmd-Start {
    if (Test-PidRunning $PID_FILE) {
        $pidVal = (Get-Content $PID_FILE).Trim()
        Write-Host "loongsuite-pilot is already running (PID $pidVal)"
        return
    }

    Ensure-Dirs
    Sync-BootstrapScripts

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }
    Write-Host "   node: $nodeBin"
    Write-Host "   bootstrap dir: $BOOTSTRAP_DIR"
    Write-Host "   config: $CONFIG_FILE"

    # best-effort 清理旧版全局 Task；若其属于其他账户（例如过去由管理员安装），
    # 删除可能被拒绝，此时保留旧 Task；当前按用户命名的新 Task 不会再与其冲突。
    # 清理失败不阻断当前用户启动。
    foreach ($legacy in $LEGACY_TASK_NAMES) {
        try { schtasks.exe /Delete /TN "$TASK_FOLDER\$legacy" /F 2>$null | Out-Null } catch {}
    }

    # 注册并启动 Task Scheduler。
    $taskInstalled = $false
    try {
        $ok1 = Install-CollectorTask $nodeBin
        $ok2 = Install-UpdaterTask $nodeBin
        if ($ok1) {
            Start-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
            if ($ok2) {
                Start-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
            }
            Set-Content -Path $INIT_TYPE_FILE -Value "taskscheduler"
            for ($i = 0; $i -lt 5; $i++) {
                Start-Sleep -Seconds 2
                if (Get-TaskRunning $TASK_NAME_COLLECTOR) {
                    Write-Host "loongsuite-pilot started (Task Scheduler)"
                    return
                }
            }
            # Task 注册成功但 10 秒内未进入 Running；5 分钟 watchdog 已安装，
            # 不能回退为后台启动，否则 watchdog 后续会再拉起第二个 Collector，
            # 造成重复采集。这里报告 LastTaskResult，并让 watchdog 继续重试。
            # 自启动配置已经存在，不应创建另一套生命周期。
            # 保持单一 Task 所有权。
            $t = Get-ScheduledTaskInfo -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
            $rc = if ($t) { "0x{0:X8}" -f $t.LastTaskResult } else { "unknown" }
            Write-Host "Task registered but not running after 10s (LastTaskResult=$rc)." -ForegroundColor Yellow
            Write-Host "   Autostart is configured; the 5-min watchdog trigger will keep retrying." -ForegroundColor Yellow
            Write-Host "   Check the task in Task Scheduler and the log below." -ForegroundColor Yellow
            return
        }
    } catch {
        $hr = ""
        if ($_.Exception -and $null -ne $_.Exception.HResult) {
            $hr = " (HRESULT 0x{0:X8})" -f $_.Exception.HResult
        }
        Write-Host "Task Scheduler registration failed$hr : $($_.Exception.Message)" -ForegroundColor Yellow
    }

    # 不再回退为不可管理的后台进程：必须成功注册 Task Scheduler。
    Remove-AllTasks
    Write-Error "Failed to register system service via Task Scheduler."
    Write-Host "   Possible causes:" -ForegroundColor Yellow
    Write-Host "     - 'Log on as a batch job' right not granted (S4U)" -ForegroundColor Yellow
    Write-Host "     - Task Scheduler service not running" -ForegroundColor Yellow
    Write-Host "     - Insufficient permissions for task registration" -ForegroundColor Yellow
    exit 1
}

# ============================================================
# 命令：stop
# ============================================================
# 停止 Scheduled Task、PID 跟踪进程和遗留进程，并清理状态文件。
function Cmd-Stop {
    # 先停止并注销 Scheduled Task。
    foreach ($name in @($TASK_NAME_UPDATER, $TASK_NAME_COLLECTOR)) {
        $task = Get-ScheduledTask -TaskName $name -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
        if ($task -and $task.State -eq "Running") {
            Stop-ScheduledTask -TaskName $name -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
        }
    }

    # 再停止 PID 文件跟踪的进程。
    Stop-PidFile $PID_FILE
    Stop-PidFile $UPDATER_PID_FILE

    # 最后清理没有有效 PID 文件的遗留进程。
    Stop-OrphanProcesses

    Write-Host "loongsuite-pilot stopped"
}

# ============================================================
# 命令：restart
# ============================================================
# 完整执行 stop 后 start，重建可能已变化的 Task action 路径。
function Cmd-Restart {
    Cmd-Stop
    Start-Sleep -Seconds 1
    Cmd-Start
}

# ============================================================
# 命令：restart-collector（Updater 部署新版本后调用）
# ============================================================
# 只切换 Collector，保留 Updater 自身，供更新部署后调用。
function Cmd-RestartCollector {
    # 只停止 Collector，保持 Updater 运行。
    $task = Get-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    }
    Stop-PidFile $PID_FILE

    # 清理遗留 Collector 进程。
    Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                $cmdLine -match "collector-daemon"
            } catch { $false }
        } | ForEach-Object {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }

    Start-Sleep -Seconds 1
    Ensure-Dirs
    Sync-BootstrapScripts

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }

    # 已注册 Task 时通过 Task Scheduler 重启。
    $restarted = $false
    if (Get-TaskExists $TASK_NAME_COLLECTOR) {
        try {
            # 路径可能随版本改变，先重新注册 Task action。
            Install-CollectorTask $nodeBin | Out-Null
            Start-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
            Write-Host "collector restarted (Task Scheduler)"
            $restarted = $true
        } catch {
            Write-Host "Task Scheduler restart failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    if (-not $restarted) {
        # 对旧版 background/unknown 降级安装尝试自愈注册 Task Scheduler。
        $initType = ""
        if (Test-Path $INIT_TYPE_FILE) { $initType = (Get-Content $INIT_TYPE_FILE -ErrorAction SilentlyContinue).Trim() }
        # `background` 是 Task Scheduler 引入前的旧 init-type，语义对应 Linux nohup/unknown。
        if ($initType -in @("background", "unknown", "")) {
            try {
                $ok = Install-CollectorTask $nodeBin
                if ($ok) {
                    Start-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
                    Start-Sleep -Seconds 1
                    if (Get-TaskRunning $TASK_NAME_COLLECTOR) {
                        Set-Content -Path $INIT_TYPE_FILE -Value "taskscheduler"
                        Write-Host "collector self-healed: registered with Task Scheduler"
                        $restarted = $true
                    }
                }
            } catch {
                Write-Host "Self-heal failed: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
        if (-not $restarted) {
            if ($initType -in @("background", "unknown", "")) {
                $entry = Join-Path $BOOTSTRAP_DIR "collector-daemon.js"
                if (-not (Test-Path $entry)) {
                    Write-Error "Bootstrap script missing"
                    exit 1
                }
                $errLog = Join-Path $LOG_DIR "loongsuite-pilot-service-err.log"
                $proc = Start-Process -FilePath "powershell.exe" `
                    -ArgumentList "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"`$env:AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'; & '$nodeBin' '$entry' >> '$LOG_FILE' 2>> '$errLog'`"" `
                    -WorkingDirectory $CACHE_DIR `
                    -WindowStyle Hidden `
                    -PassThru
                Set-Content -Path $PID_FILE -Value $proc.Id
                Write-Host "collector restarted (background fallback, self-heal failed)" -ForegroundColor Yellow
            } else {
                Write-Error "Service manager failed to restart collector (init_type=$initType)"
                exit 1
            }
        }
    }

    # 后台安排 Updater 自重启，作用类似 Linux setsid，避免当前进程终止连带杀死重启任务。
    Start-Job -ScriptBlock {
        Start-Sleep -Seconds 10
        & $using:LOONGSUITE_PILOT_BIN restart-updater
    } | Out-Null
}

# ============================================================
# 命令：restart-updater
# ============================================================
# 只停止并重新注册/启动 Updater Task，不干扰 Collector。
function Cmd-RestartUpdater {
    # 只停止 Updater。
    $task = Get-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    }
    Stop-PidFile $UPDATER_PID_FILE

    Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                $cmdLine -match "updater-daemon"
            } catch { $false }
        } | ForEach-Object {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }

    Start-Sleep -Seconds 1
    Ensure-Dirs
    Sync-BootstrapScripts

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        return
    }

    # 通过 Task Scheduler 重启。
    $restarted = $false
    if (Get-TaskExists $TASK_NAME_UPDATER) {
        try {
            Install-UpdaterTask $nodeBin | Out-Null
            Start-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
            Start-Sleep -Seconds 1
            if (Get-TaskRunning $TASK_NAME_UPDATER) {
                Write-Host "updater restarted (Task Scheduler)"
                $restarted = $true
            }
        } catch {
            Write-Host "Task Scheduler restart failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    if (-not $restarted) {
        # 对旧版 background/unknown 降级安装尝试自愈注册 Task Scheduler。
        $initType = ""
        if (Test-Path $INIT_TYPE_FILE) { $initType = (Get-Content $INIT_TYPE_FILE -ErrorAction SilentlyContinue).Trim() }
        # `background` 是 Task Scheduler 引入前的旧 init-type，语义对应 Linux nohup/unknown。
        if ($initType -in @("background", "unknown", "")) {
            try {
                $ok = Install-UpdaterTask $nodeBin
                if ($ok) {
                    Start-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
                    Start-Sleep -Seconds 1
                    if (Get-TaskRunning $TASK_NAME_UPDATER) {
                        Set-Content -Path $INIT_TYPE_FILE -Value "taskscheduler"
                        Write-Host "updater self-healed: registered with Task Scheduler"
                        $restarted = $true
                    }
                }
            } catch {
                Write-Host "Self-heal failed: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
        if (-not $restarted) {
            if ($initType -in @("background", "unknown", "")) {
                $entry = Join-Path $BOOTSTRAP_DIR "updater-daemon.js"
                if (-not (Test-Path $entry)) {
                    Write-Host "Updater bootstrap script missing"
                    return
                }
                $updaterErrLog = Join-Path $LOG_DIR "loongsuite-pilot-updater-err.log"
                $proc = Start-Process -FilePath "powershell.exe" `
                    -ArgumentList "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"`$env:AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'; & '$nodeBin' '$entry' >> '$UPDATER_LOG_FILE' 2>> '$updaterErrLog'`"" `
                    -WorkingDirectory $CACHE_DIR `
                    -WindowStyle Hidden `
                    -PassThru
                Set-Content -Path $UPDATER_PID_FILE -Value $proc.Id
                Write-Host "updater restarted (background fallback, self-heal failed)" -ForegroundColor Yellow
            } else {
                Write-Error "Service manager failed to restart updater (init_type=$initType)"
                return
            }
        }
    }
}

# ============================================================
# 命令：status
# ============================================================
# 综合 PID、Scheduled Task 和 init-type 输出 Collector/Updater/自启动状态。
function Cmd-Status {
    $verInfo = ""
    $versionDir = Resolve-CurrentVersion
    if ($versionDir) {
        $info = Get-VersionInfo $versionDir
        if ($info.version) {
            $verInfo = " v$($info.version) ($($info.git_commit))"
        }
    }

    # Collector 状态。
    $collectorRunning = $false
    if (Test-PidRunning $PID_FILE) {
        $pidVal = (Get-Content $PID_FILE).Trim()
        Write-Host "loongsuite-pilot${verInfo} is running (PID $pidVal)"
        $collectorRunning = $true
    } elseif (Get-TaskRunning $TASK_NAME_COLLECTOR) {
        Write-Host "loongsuite-pilot${verInfo} is running (Task Scheduler)"
        $collectorRunning = $true
    }
    if (-not $collectorRunning) {
        Write-Host "loongsuite-pilot${verInfo} is not running"
    }

    # Updater 状态。
    if (Test-PidRunning $UPDATER_PID_FILE) {
        $pidVal = (Get-Content $UPDATER_PID_FILE).Trim()
        Write-Host "   updater: running (PID $pidVal)"
    } elseif (Get-TaskRunning $TASK_NAME_UPDATER) {
        Write-Host "   updater: running (Task Scheduler)"
    } else {
        Write-Host "   updater: stopped"
    }

    # 自启动状态。
    if (Get-TaskExists $TASK_NAME_COLLECTOR) {
        $task = Get-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\"
        $triggerInfo = if ($task.Triggers.Count -gt 0) { $task.Triggers[0].CimClass.CimClassName } else { "none" }
        Write-Host "   autostart: enabled (Task Scheduler, trigger: AtLogon)"
    } else {
        $initType = ""
        if (Test-Path $INIT_TYPE_FILE) { $initType = (Get-Content $INIT_TYPE_FILE -ErrorAction SilentlyContinue).Trim() }
        if ($initType -eq "background") {
            Write-Host "   autostart: disabled (background process fallback)"
        } else {
            Write-Host "   autostart: not configured"
        }
    }
}

# ============================================================
# 命令：info
# ============================================================
# 输出版本指针、Node、数据目录、配置、PID、日志和 Task 名称等诊断。
function Cmd-Info {
    $versionDir = Resolve-CurrentVersion
    if ($versionDir) {
        $vf = Join-Path $versionDir "VERSION"
        if (Test-Path $vf) {
            Get-Content $vf
        } else {
            Write-Host "version=unknown"
        }
    } else {
        Write-Host "version=unknown"
    }

    Write-Host ""
    Write-Host "data_dir=$DATA_DIR"
    Write-Host "config=$CONFIG_FILE"
    Write-Host "log=$LOG_FILE"
    Write-Host "versions_dir=$VERSIONS_DIR"

    if (Test-Path $NODE_PIN_FILE) {
        $pinnedNode = (Get-Content $NODE_PIN_FILE -ErrorAction SilentlyContinue).Trim()
        if ($pinnedNode -and (Test-Path $pinnedNode)) {
            $nodeVer = & $pinnedNode --version 2>$null
            Write-Host "node_bin=$pinnedNode"
            Write-Host "node_version=$nodeVer"
        } else {
            Write-Host "node_bin=$pinnedNode (stale)"
            $resolved = Resolve-Node
            if ($resolved) {
                $nodeVer = & $resolved --version 2>$null
                Write-Host "node_version=$nodeVer"
            }
        }
    } else {
        Write-Host "node_bin=not pinned"
        $resolved = Resolve-Node
        if ($resolved) {
            $nodeVer = & $resolved --version 2>$null
            Write-Host "node_resolved=$resolved"
            Write-Host "node_version=$nodeVer"
        }
    }

    Write-Host ""
    if (Test-Path $CONFIG_FILE) {
        Get-Content $CONFIG_FILE
    }
}

# ============================================================
# 命令：rollback
# ============================================================
# 交换 current/previous、同步目标脚本并重启；失败时恢复原指针。
function Cmd-Rollback {
    if (-not (Test-Path $PREVIOUS_FILE)) {
        Write-Error "No previous version to roll back to"
        exit 1
    }

    $prevDir = (Get-Content $PREVIOUS_FILE -ErrorAction SilentlyContinue).Trim()
    $prevPath = Join-Path $VERSIONS_DIR $prevDir
    if (-not $prevDir -or -not (Test-Path $prevPath)) {
        Write-Error "Previous version directory not found: $prevDir"
        exit 1
    }

    $currDir = ""
    if (Test-Path $CURRENT_FILE) {
        $currDir = (Get-Content $CURRENT_FILE -ErrorAction SilentlyContinue).Trim()
    }

    # 交换 current/previous 指针。
    Set-Content -Path $CURRENT_FILE -Value $prevDir
    if ($currDir) {
        Set-Content -Path $PREVIOUS_FILE -Value $currDir
    }

    # 从回滚目标版本同步稳定脚本。
    $ok = Sync-InstalledScriptsFromVersion $prevPath
    if (-not $ok) {
        # 同步或启动失败时恢复原指针。
        if ($currDir) {
            Set-Content -Path $CURRENT_FILE -Value $currDir
            Set-Content -Path $PREVIOUS_FILE -Value $prevDir
            Sync-InstalledScriptsFromVersion (Join-Path $VERSIONS_DIR $currDir) | Out-Null
        }
        Write-Error "Failed to sync scripts for rollback target: $prevDir"
        exit 1
    }

    Write-Host "Rolled back to version: $prevDir"
    Write-Host "   Restarting service..."
    Cmd-Restart
}

# ============================================================
# 命令：log（持续查看服务日志）
# ============================================================
# 尾随 Collector 日志，文件不存在时给出明确提示。
function Cmd-Log {
    if (Test-Path $LOG_FILE) {
        Get-Content $LOG_FILE -Tail 50 -Wait
    } else {
        Write-Host "No log file found: $LOG_FILE"
    }
}

# ============================================================
# 命令：span-attr/help
# ============================================================
# 管理注入 Trace span 的用户自定义 span-attributes.json；
# 这些属性不写入事件日志，Collector 每个 turn 都会重新读取，
# 因此修改无需重启即可生效。
# 通过内嵌 Node 程序原子管理 span-attributes.json。
function Cmd-SpanAttr {
    $sub = if ($SubArgs.Count -ge 1) { $SubArgs[0] } else { "" }

    if ($sub -ieq "clear") {
        if (Test-Path $SPAN_ATTR_FILE) { Remove-Item $SPAN_ATTR_FILE -Force }
        Write-Host "cleared custom span attributes ($SPAN_ATTR_FILE)"
        return
    }

    if ($sub.ToLower() -in @("set", "unset", "list")) {
        $nodeBin = Resolve-Node
        if (-not $nodeBin) { Write-Error "[span-attr] node runtime not found"; exit 1 }
        $js = @'
const fs = require("fs");
const file = process.argv[1], op = process.argv[2], key = process.argv[3], value = process.argv[4];
const RESERVED = ["gen_ai.","git.","workspace.","event.","trace_","user.","cost_","agent.","time_unix_nano","observed_time_unix_nano"];
const isReserved = k => RESERVED.some(p => k === p || k.indexOf(p) === 0);
function read() { try { const o = JSON.parse(fs.readFileSync(file, "utf-8")); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; } catch { return {}; } }
function write(o) { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n"); fs.renameSync(tmp, file); }
if (op === "set") {
  if (!key || value === undefined) { console.error("usage: span-attr set <key> <value>"); process.exit(1); }
  if (isReserved(key)) { console.error("refused: \"" + key + "\" uses a reserved prefix (gen_ai./git./workspace./event./trace_/user./cost_/agent./...)"); process.exit(1); }
  const o = read(); o[key] = String(value); write(o); console.log("set " + key + "=" + o[key]);
} else if (op === "unset") {
  if (!key) { console.error("usage: span-attr unset <key>"); process.exit(1); }
  const o = read(); if (Object.prototype.hasOwnProperty.call(o, key)) { delete o[key]; write(o); console.log("unset " + key); } else { console.log("(no such key: " + key + ")"); }
} else if (op === "list") {
  const o = read(); const ks = Object.keys(o);
  if (ks.length === 0) { console.log("(no custom span attributes)"); } else { for (const k of ks) console.log(k + "=" + o[k]); }
}
'@
        $rest = if ($SubArgs.Count -ge 2) { $SubArgs[1..($SubArgs.Count - 1)] } else { @() }
        & $nodeBin -e $js $SPAN_ATTR_FILE $sub @rest
        exit $LASTEXITCODE
    }

    Write-Host "Usage: loongsuite-pilot span-attr <set|unset|list|clear>"
    Write-Host ""
    Write-Host "  set <key> <value>   Set a custom trace span attribute"
    Write-Host "  unset <key>         Remove a custom attribute"
    Write-Host "  list                Show current custom attributes"
    Write-Host "  clear               Remove all custom attributes"
    Write-Host ""
    Write-Host "Attributes are injected into trace spans only (not the event log)."
    Write-Host "Reserved-prefix keys (gen_ai./git./workspace./event./trace_/user./cost_/agent./...) are rejected."
    Write-Host "Changes take effect on the next turn - no restart needed."
    if ($sub -ne "" -and $sub.ToLower() -notin @("help", "-h", "--help")) { exit 1 }
}

# 打印 Windows 运维 CLI 命令和参数帮助。
function Cmd-Help {
    Write-Host "Usage: loongsuite-pilot <command>"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  start           Start the collector service"
    Write-Host "  stop            Stop the collector service"
    Write-Host "  restart         Restart the collector service"
    Write-Host "  status          Show service status (default)"
    Write-Host "  info            Show version and config info"
    Write-Host "  log             Tail the service log"
    Write-Host "  span-attr ...   Manage custom trace span attributes (set/unset/list/clear)"
    Write-Host "  rollback        Roll back to the previous version"
    Write-Host "  help            Show this help message"
}

# ============================================================
# 子命令分派
# ============================================================
switch ($Command.ToLower()) {
    "start"              { Cmd-Start }
    "stop"               { Cmd-Stop }
    "restart"            { Cmd-Restart }
    "status"             { Cmd-Status }
    "info"               { Cmd-Info }
    "log"                { Cmd-Log }
    "rollback"           { Cmd-Rollback }
    "restart-collector"  { Cmd-RestartCollector }
    "restart-updater"    { Cmd-RestartUpdater }
    "run"                { Cmd-Run }
    "run-updater"        { Cmd-RunUpdater }
    "span-attr"          { Cmd-SpanAttr }
    { $_ -in "help","--help","-h" } { Cmd-Help }
    default {
        Write-Host "Unknown command: $Command"
        Cmd-Help
        exit 1
    }
}
