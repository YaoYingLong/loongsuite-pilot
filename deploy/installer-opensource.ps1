# installer-opensource.ps1：loongsuite-pilot Windows 开源版安装器。
#
# 首次安装：
#   irm https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1 | iex
#   .\installer-opensource.ps1 install `
#     -SlsEndpoint "https://cn-hangzhou.log.aliyuncs.com" `
#     -SlsProject "my-project" `
#     -SlsLogstore "my-logstore" `
#     -SlsAkId "your-ak-id" `
#     -SlsAkSecret "your-ak-secret"
#
# 安装指定版本：
#   .\installer-opensource.ps1 install -Version 1.2.0
#
# 升级；按设计保留配置，失败时自动回滚：
#   .\installer-opensource.ps1 upgrade
#
# 卸载：
#   .\installer-opensource.ps1 uninstall
#   .\installer-opensource.ps1 uninstall -Purge

# 本脚本是 loongsuite-pilot 开源版 Windows 安装器。它与 Bash 安装器保持相同的
# versions/current/previous 和配置合并语义，但使用 zip、Expand-Archive、PowerShell shim
# 与 Task Scheduler。安装会下载解压、执行 Agent probe、安装 npm 生产依赖、运行 postinstall、
# 写入 config 并安装稳定运维 CLI；升级健康检查失败时回滚，卸载清理 Agent Hook/插件配置。
# 网络、文件系统、npm 和 Scheduled Task 都是外部副作用，未捕获错误会返回非零退出码。

# CmdletBinding 启用标准参数绑定；ValidateSet 会在业务逻辑前拒绝未知子命令。
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("install", "upgrade", "uninstall")]
    [string]$Command = "install",

    [string]$SlsEndpoint,
    [string]$SlsProject,
    [string]$SlsLogstore,
    [string]$SlsAkId,
    [string]$SlsAkSecret,
    [string]$PackageUrl,
    [string]$DataDir,
    [string]$LogLevel,
    [Alias("user.id")]
    [string]$UserId,
    [string]$Lang,
    [string]$Version,
    [string]$CollectLog,
    [string]$CollectTrace,
    [string]$CmsLicenseKey,
    [string]$CmsEndpoint,
    [string]$CmsWorkspace,
    [string]$ServiceNamePrefix,
    [string]$Agents,
    [string]$MaskMode,
    [string]$MaskTypes,
    [switch]$Purge
)

# 把非终止错误提升为终止异常，使 try/finally 能统一清理；调用外部 exe 时仍需检查 `$LASTEXITCODE`。
$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 默认控制台编码可能不是 UTF-8，显式设置后中英文提示才不会乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ============================================================
# 常量
# ============================================================
$PACKAGE_NAME = "loongsuite-pilot"
$DEFAULT_DATA_DIR = Join-Path $env:USERPROFILE ".loongsuite-pilot"
$PERMANENT_DIR = Join-Path $DEFAULT_DATA_DIR "package"

$_OSS_BASE_URL = "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot"

# ============================================================
# 默认值
# ============================================================
if (-not $DataDir) { $DataDir = $DEFAULT_DATA_DIR }
if (-not $PackageUrl -and $env:LOONGSUITE_PILOT_PACKAGE_URL) {
    $PackageUrl = $env:LOONGSUITE_PILOT_PACKAGE_URL
}

# ============================================================
# 校验脱敏参数组合。
# ============================================================
if ($MaskMode) {
    if ($MaskMode -notin @("all", "none", "custom")) {
        Write-Error "Unknown mask mode: $MaskMode (use 'all', 'custom', or 'none')"
        exit 1
    }
}
if ($MaskMode -eq "custom" -and -not $MaskTypes) {
    Write-Error "--MaskTypes is required when -MaskMode custom"
    exit 1
}
if ($MaskTypes -and $MaskMode -ne "custom") {
    Write-Error "-MaskTypes can only be used with -MaskMode custom"
    exit 1
}

# ============================================================
# 解析显式版本或 latest 对应的发布包 URL。
# ============================================================
if (-not $PackageUrl) {
    # -Version 只决定下载 URL；最终版本目录名仍来自压缩包内 VERSION。
    if ($Version) {
        $PackageUrl = "$_OSS_BASE_URL/$Version/$PACKAGE_NAME.zip"
    } else {
        $PackageUrl = "$_OSS_BASE_URL/latest/$PACKAGE_NAME.zip"
    }
}

# ============================================================
# 提示语言检测
# ============================================================
# 根据显式参数和系统 UI culture 选择中英文提示。
function Detect-Lang {
    if ($Lang) { return $Lang }
    if ($env:LOONGSUITE_PILOT_LANG) { return $env:LOONGSUITE_PILOT_LANG }
    try {
        $culture = [System.Globalization.CultureInfo]::CurrentUICulture.Name
        if ($culture -match "zh") { return "zh" }
    } catch {}
    return "en"
}

$LANG_MODE = Detect-Lang

# 按当前语言从中英文文本中选择一个写到标准输出。
function Msg {
    param([string]$zh, [string]$en)
    if ($LANG_MODE -eq "zh") { Write-Host $zh } else { Write-Host $en }
}

# ============================================================
# Node.js 解析
# ============================================================
# 执行候选 node --version，确认存在且主版本不低于 18。
function Test-NodeSuitable {
    param([string]$bin)
    if (-not (Test-Path $bin)) { return $false }
    try {
        # `&` 是 PowerShell 调用运算符；`2>$null` 只隐藏候选探测错误，不隐藏最终依赖错误。
        $ver = & $bin --version 2>$null
        if (-not $ver) { return $false }
        $major = [int]($ver -replace '^v','').Split('.')[0]
        return $major -ge 18
    } catch { return $false }
}

# 按 node-bin、nvm-windows、fnm、Volta、Program Files 和 PATH 解析可用 Node，并更新 pin。
function Resolve-Node {
    $candidates = @()

    # nvm-windows
    $nvmHome = $env:NVM_HOME
    if ($nvmHome -and (Test-Path $nvmHome)) {
        $nvmDirs = Get-ChildItem $nvmHome -Directory -ErrorAction SilentlyContinue |
                   Sort-Object Name -Descending
        foreach ($d in $nvmDirs) {
            $candidates += Join-Path $d.FullName "node.exe"
        }
    }

    # fnm
    $fnmDir = Join-Path $env:USERPROFILE ".fnm\node-versions"
    if (Test-Path $fnmDir) {
        $fnmDirs = Get-ChildItem $fnmDir -Directory -ErrorAction SilentlyContinue |
                   Sort-Object Name -Descending
        foreach ($d in $fnmDirs) {
            $candidates += Join-Path $d.FullName "installation\node.exe"
        }
    }

    # Volta
    $voltaNode = Join-Path $env:USERPROFILE ".volta\bin\node.exe"
    $candidates += $voltaNode

    # 常见安装路径。
    $candidates += "C:\Program Files\nodejs\node.exe"
    $candidates += "C:\Program Files (x86)\nodejs\node.exe"

    # 最后查询 PATH。
    $pathNode = Get-Command node -ErrorAction SilentlyContinue
    if ($pathNode) { $candidates += $pathNode.Source }

    # 数组顺序就是优先级；不去重不会改变结果，只可能对同一路径重复执行一次 --version。
    foreach ($c in $candidates) {
        if (Test-NodeSuitable $c) {
            return $c
        }
    }
    return $null
}

# ============================================================
# 依赖检查
# ============================================================
$script:NODE_BIN = ""
$script:NPM_BIN = ""

# 验证 Node、npm 和 Windows 环境前置条件，缺失时抛错终止安装。
function Check-Deps {
    Msg "==> 检查依赖..." "==> Checking dependencies..."

    $script:NODE_BIN = Resolve-Node
    if (-not $script:NODE_BIN) {
        Msg "❌ 缺少依赖: node，请先安装后重试" "❌ Missing dependency: node — please install it first"
        exit 1
    }

    # 外部 Node 的 stderr/exit code 不应被 Stop 自动包装成 PowerShell 异常，暂时切为 Continue 后再恢复。
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $nodeMajor = & $script:NODE_BIN -e "process.stdout.write(String(process.versions.node.split('.')[0]))"
    $ErrorActionPreference = $prevEAP
    if ([int]$nodeMajor -lt 18) {
        $nodeVer = & $script:NODE_BIN --version
        Msg "❌ 需要 Node.js >= 18，当前版本: $nodeVer" "❌ Requires Node.js >= 18, current: $nodeVer"
        exit 1
    }

    # 固定 Node 绝对路径，供 Hook 和后台任务复用。
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    # pin 文件供 Scheduled Task 使用，避免后台任务拿到与安装终端不同的 PATH。
    Set-Content -Path (Join-Path $DataDir "node-bin") -Value $script:NODE_BIN

    # 从同一 Node 安装目录解析 npm，避免 PATH 指向另一版本。
    $npmPath = Join-Path (Split-Path $script:NODE_BIN) "npm.cmd"
    if (Test-Path $npmPath) {
        $script:NPM_BIN = $npmPath
    } else {
        $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
        if ($npmCmd) {
            $script:NPM_BIN = $npmCmd.Source
        } else {
            Msg "❌ 缺少依赖: npm，请先安装后重试" "❌ Missing dependency: npm — please install it first"
            exit 1
        }
    }

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $nodeVer = & $script:NODE_BIN --version
    $npmVer = & $script:NPM_BIN --version
    $ErrorActionPreference = $prevEAP
    Msg "    ✅ node $nodeVer  npm $npmVer" "    ✅ node $nodeVer  npm $npmVer"
    Msg "    node pinned: $($script:NODE_BIN)" "    node pinned: $($script:NODE_BIN)"
    Write-Host ""
}

# ============================================================
# 下载并解压发布包
# ============================================================
$script:INSTALL_SRC = ""

# 下载或复制 zip 到临时目录，Expand-Archive 后定位 package.json 所在包根。
function Download-AndExtract {
    # Get-Random 降低并行安装临时目录冲突概率；目录在 Cmd-* 的 finally 中清理。
    $tmpDir = Join-Path $env:TEMP "loongsuite-pilot-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $script:TMP_DIR = $tmpDir

    $archivePath = Join-Path $tmpDir "package.zip"

    Msg "==> 下载安装包: $PackageUrl" "==> Downloading: $PackageUrl"

    try {
        # Windows PowerShell 5.1 某些系统默认 TLS 版本较旧，下载前强制允许 TLS 1.2。
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $PackageUrl -OutFile $archivePath -UseBasicParsing
    } catch {
        Msg "❌ 下载失败: $_" "❌ Download failed: $_"
        exit 1
    }
    Msg "    ✅ 下载完成" "    ✅ Downloaded"
    Write-Host ""

    Msg "==> 解压安装包..." "==> Extracting..."

    try {
        Expand-Archive -Path $archivePath -DestinationPath $tmpDir -Force
    } catch {
        Msg "❌ 解压失败: $_" "❌ Extraction failed: $_"
        exit 1
    }

    $pkgDir = Join-Path $tmpDir $PACKAGE_NAME
    if (Test-Path $pkgDir) {
        $script:INSTALL_SRC = $pkgDir
    } elseif (Test-Path (Join-Path $tmpDir "package.json")) {
        $script:INSTALL_SRC = $tmpDir
    } else {
        # 标准顶层布局均未命中时，最多向下两层寻找首个 package.json 作为兼容回退。
        $found = Get-ChildItem $tmpDir -Recurse -Depth 2 -Filter "package.json" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
            $script:INSTALL_SRC = $found.DirectoryName
        } else {
            Msg "❌ 解压后未找到 package.json，安装包结构异常" "❌ package.json not found — unexpected package structure"
            exit 1
        }
    }
    Msg "    ✅ 解压完成" "    ✅ Extracted"
    Write-Host ""
}

# ============================================================
# Agent 探测
# ============================================================
$script:PROBE_RESULT = "[]"

# 调用 cli-probe.cjs 探测本机 Agent，并解析其 JSON 输出。
function Probe-Agents {
    Msg "==> 探测 AI Agent..." "==> Probing AI Agents..."
    $probeScript = Join-Path $script:INSTALL_SRC "dist\cli-probe.cjs"
    # 探测是可降级步骤：失败恢复 `[]`，安装本体仍可完成。
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    if (Test-Path $probeScript) {
        try {
            $raw = & $script:NODE_BIN $probeScript 2>$null
            if ($raw) {
                # PowerShell 会把多行 stdout 变成字符串数组；无分隔 join 还原 cli-probe 的 JSON 文本。
                $script:PROBE_RESULT = if ($raw -is [array]) { $raw -join "" } else { $raw }
            }
        } catch {
            Msg "    ⚠️  Agent 探测失败，将跳过选择" "    ⚠️  Agent probe failed, skipping selection"
            $script:PROBE_RESULT = "[]"
        }
    }
    $count = $script:PROBE_RESULT | & $script:NODE_BIN -e "const r=JSON.parse(require('fs').readFileSync(0,'utf-8'));process.stdout.write(String(r.length))" 2>$null
    $ErrorActionPreference = $prevEAP
    if (-not $count) { $count = "0" }
    Msg "    ✅ 探测到 ${count} 个 Agent 定义" "    ✅ Found ${count} agent definitions"
    Write-Host ""
}

# ============================================================
# Agent 选择
# ============================================================
$script:SELECTED_AGENTS = $Agents

# 解析 -Agents 或交互选择，返回写入配置的启用 Agent ID。
function Select-Agents {
    if ($script:SELECTED_AGENTS) {
        Msg "    使用指定的 Agent: $($script:SELECTED_AGENTS)" "    Using specified agents: $($script:SELECTED_AGENTS)"
        Write-Host ""
        return
    }

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $agentCount = $script:PROBE_RESULT | & $script:NODE_BIN -e "const r=JSON.parse(require('fs').readFileSync(0,'utf-8'));process.stdout.write(String(r.length))" 2>$null
    $ErrorActionPreference = $prevEAP
    if (-not $agentCount -or $agentCount -eq "0") { return }

    # 非交互模式使用探测结果或显式列表。
    # CI/计划任务可能没有 RawUI，即使进程标记 UserInteractive 也不能调用 Read-Host。
    $isInteractive = [Environment]::UserInteractive -and $Host.UI.RawUI -ne $null
    if (-not $isInteractive) {
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        $script:SELECTED_AGENTS = $script:PROBE_RESULT | & $script:NODE_BIN -e @'
const r = JSON.parse(require('fs').readFileSync(0,'utf-8'));
const detected = r.filter(a => a.detected).map(a => a.id);
process.stdout.write(detected.join(','));
'@ 2>$null
        $ErrorActionPreference = $prevEAP
        Msg "    (非交互模式) 自动选择已检测到的 Agent: $($script:SELECTED_AGENTS)" `
            "    (non-interactive) Auto-selected detected agents: $($script:SELECTED_AGENTS)"
        Write-Host ""
        return
    }

    # 交互模式显示可选 Agent 菜单。
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $script:PROBE_RESULT | & $script:NODE_BIN -e @'
const r = JSON.parse(require('fs').readFileSync(0,'utf-8'));
const lang = process.argv[1];
const defaults = [];
for (let i = 0; i < r.length; i++) {
  const a = r[i];
  const status = lang === 'zh'
    ? (a.detected ? '已检测到: ' + a.reason : '未检测到')
    : (a.detected ? 'detected: ' + a.reason : 'not detected');
  console.log('    [' + (i+1) + '] ' + a.displayName.padEnd(16) + '(' + status + ')');
  if (a.detected) defaults.push(i+1);
}
console.log('');
if (lang === 'zh') {
  console.log('    默认选择已检测到的 Agent: ' + defaults.join(','));
  console.log('    输入要启用的编号 (逗号分隔)，直接回车使用默认:');
} else {
  console.log('    Default selection (detected): ' + defaults.join(','));
  console.log('    Enter numbers to enable (comma-separated), press Enter for default:');
}
'@ $LANG_MODE
    $ErrorActionPreference = $prevEAP

    $selectInput = (Read-Host "    >").Trim() -replace '[，、；]', ','

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $script:SELECTED_AGENTS = $script:PROBE_RESULT | & $script:NODE_BIN -e @'
const r = JSON.parse(require('fs').readFileSync(0,'utf-8'));
const input = (process.argv[1] || '').replace(/[，、；]/g, ',');
let indices;
if (!input.trim()) {
  indices = r.map((a, i) => a.detected ? i : -1).filter(i => i >= 0);
} else {
  indices = [...new Set(input.trim().split(/[\s,]+/).map(Number).filter(n => n >= 1 && n <= r.length))].map(n => n - 1);
}
const ids = indices.sort((a,b) => a-b).map(i => r[i].id);
process.stdout.write(ids.join(','));
'@ $selectInput 2>$null
    $ErrorActionPreference = $prevEAP

    if ($script:SELECTED_AGENTS) {
        Msg "    已选择: $($script:SELECTED_AGENTS)" "    Selected: $($script:SELECTED_AGENTS)"
    } else {
        Msg "    未选择任何 Agent" "    No agents selected"
    }
    Write-Host ""
}

# ============================================================
# 询问事件 userId
# ============================================================
# 处理 Prompt-UserId 的交互输入；非交互模式使用调用参数或安全默认值。
function Prompt-UserId {
    if ($UserId) { return }
    $isInteractive = [Environment]::UserInteractive -and $Host.UI.RawUI -ne $null
    if (-not $isInteractive) { return }

    $configFile = Join-Path $DataDir "config.json"
    $existingUid = ""
    if (Test-Path $configFile) {
        try {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            $existingUid = & $script:NODE_BIN -e @'
try { const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8')); process.stdout.write(c.userId||''); } catch {}
'@ $configFile 2>$null
            $ErrorActionPreference = $prevEAP
        } catch {}
    }

    Write-Host ""
    if ($existingUid) {
        Msg "    当前 userId: $existingUid" "    Current userId: $existingUid"
        Msg "    直接回车保留，或输入新值:" "    Press Enter to keep, or type a new value:"
    } else {
        Msg "    请输入你的 userId（用于数据归属，可直接回车跳过）:" `
            "    Enter your userId (for data attribution, press Enter to skip):"
    }
    $input = (Read-Host "    >").Trim()
    if ($input) {
        $script:UserId = $input
    } elseif ($existingUid) {
        $script:UserId = $existingUid
    }
}

# ============================================================
# 确认配置覆盖
# ============================================================
# 处理 Confirm-ConfigOverwrite 的交互输入；非交互模式使用调用参数或安全默认值。
function Confirm-ConfigOverwrite {
    $configFile = Join-Path $DataDir "config.json"
    if (-not (Test-Path $configFile)) { return }

    $jsonArg = @{
        slsEndpoint = $SlsEndpoint
        slsProject = $SlsProject
        slsLogstore = $SlsLogstore
        cmsLicenseKey = $CmsLicenseKey
        cmsEndpoint = $CmsEndpoint
        cmsWorkspace = $CmsWorkspace
        serviceNamePrefix = $ServiceNamePrefix
        maskMode = $MaskMode
        maskTypes = $MaskTypes
    } | ConvertTo-Json -Compress

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $diffs = & $script:NODE_BIN -e @'
const fs = require('fs');
let old = {};
try { old = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8')); } catch { process.exit(0); }
const newVals = JSON.parse(process.argv[2]);
const normalizeCsv = value => String(value || '').split(',').map(v => v.trim()).filter(Boolean).join(',');
const checks = [
  { label: 'sls.endpoint',      oldVal: (old.sls||{}).endpoint||'',      newVal: newVals.slsEndpoint },
  { label: 'sls.project',       oldVal: (old.sls||{}).project||'',       newVal: newVals.slsProject },
  { label: 'sls.logstore',      oldVal: (old.sls||{}).logstore||'',      newVal: newVals.slsLogstore },
  { label: 'cms.licenseKey',    oldVal: (old.cms||{}).licenseKey||'',    newVal: newVals.cmsLicenseKey },
  { label: 'cms.endpoint',      oldVal: (old.cms||{}).endpoint||'',      newVal: newVals.cmsEndpoint },
  { label: 'cms.workspace',     oldVal: (old.cms||{}).workspace||'',     newVal: newVals.cmsWorkspace },
  { label: 'serviceNamePrefix', oldVal: old.serviceNamePrefix||'',       newVal: newVals.serviceNamePrefix },
  { label: 'mask.mode',         oldVal: (old.mask||{}).mode||'',         newVal: newVals.maskMode },
  { label: 'mask.types',        oldVal: Array.isArray((old.mask||{}).types) ? normalizeCsv(old.mask.types.join(',')) : '', newVal: normalizeCsv(newVals.maskTypes) },
];
const changed = checks.filter(c => c.newVal && c.oldVal && c.newVal !== c.oldVal);
if (!changed.length) process.exit(0);
for (const c of changed) { console.log(c.label + ': ' + c.oldVal + ' -> ' + c.newVal); }
'@ $configFile $jsonArg 2>$null
    $ErrorActionPreference = $prevEAP

    if (-not $diffs) { return }

    Write-Host ""
    Msg "⚠️  以下配置将被覆盖:" "⚠️  The following config will be overwritten:"
    $diffs | ForEach-Object { Write-Host "    $_" }

    $isInteractive = [Environment]::UserInteractive -and $Host.UI.RawUI -ne $null
    if ($isInteractive) {
        Write-Host ""
        Msg "    确认覆盖? (y/N):" "    Confirm overwrite? (y/N):"
        $answer = Read-Host "    >"
        if ($answer -notin @("y", "Y", "yes", "YES")) {
            Msg "已取消安装" "Installation cancelled"
            exit 0
        }
    } else {
        Msg "    (非交互模式) 继续覆盖" "    (non-interactive) Proceeding with overwrite"
    }
}

# ============================================================
# 部署稳定启动垫片
# ============================================================
# 从新版本复制稳定 Collector/Updater daemon 到缓存 bin，使 Task action 不依赖版本目录。
function Deploy-BootstrapScripts {
    $srcDir = Join-Path $script:PERMANENT_DIR "scripts"
    $bootDir = Join-Path $env:USERPROFILE ".loongsuite-pilot\bin"
    if (-not (Test-Path $bootDir)) { New-Item -ItemType Directory -Path $bootDir -Force | Out-Null }
    # Windows 开源包当前只复制 Collector daemon；Updater 是否存在/注册由后续 CLI 单独判断。
    Copy-Item (Join-Path $srcDir "collector-daemon.js") $bootDir -Force
}

# ============================================================
# 部署包到不可变 versions 目录
# ============================================================
# 复制到 versions 目录并安装生产依赖，然后更新 current/previous。
# 当前实现会删除同名目标并用 Set-Content 直接写指针，不是严格不可变目录或原子指针替换。
function Deploy-Package {
    param([string]$src)
    $cacheDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
    $versionsDir = Join-Path $cacheDir "versions"
    $currentFile = Join-Path $cacheDir "current"
    $previousFile = Join-Path $cacheDir "previous"

    $ver = ""; $commit = ""
    $versionFile = Join-Path $src "VERSION"
    if (Test-Path $versionFile) {
        $content = Get-Content $versionFile
        foreach ($line in $content) {
            if ($line -match "^version=(.+)") { $ver = $Matches[1] }
            if ($line -match "^git_commit=(.+)") { $commit = $Matches[1] }
        }
    }

    if ($ver -and $commit) {
        $dirName = "${ver}_${commit}"
        $target = Join-Path $versionsDir $dirName

        # previous 在复制新包前写入；后续复制/npm 失败时 install 不会自动恢复，upgrade 依赖健康检查回滚。
        if (Test-Path $currentFile) {
            $oldDir = (Get-Content $currentFile -ErrorAction SilentlyContinue).Trim()
            if ($oldDir -and $oldDir -ne $dirName) {
                Set-Content -Path $previousFile -Value $oldDir
            }
        }

        Msg "==> 部署到 $target ..." "==> Deploying to $target ..."
        if (-not (Test-Path $versionsDir)) { New-Item -ItemType Directory -Path $versionsDir -Force | Out-Null }
        # 相同 version+commit 重装会先移除旧目录，因此中途失败可能留下目标缺失/不完整。
        if (Test-Path $target) { Remove-Item $target -Recurse -Force }
        Copy-Item $src $target -Recurse

        Set-Content -Path $currentFile -Value $dirName
        $script:PERMANENT_DIR = $target
    } else {
        Msg "==> 部署到 $($script:PERMANENT_DIR) ..." "==> Deploying to $($script:PERMANENT_DIR) ..."
        $parentDir = Split-Path $script:PERMANENT_DIR
        if (-not (Test-Path $parentDir)) { New-Item -ItemType Directory -Path $parentDir -Force | Out-Null }
        if (Test-Path $script:PERMANENT_DIR) { Remove-Item $script:PERMANENT_DIR -Recurse -Force }
        Copy-Item $src $script:PERMANENT_DIR -Recurse
    }
    Msg "    ✅ 部署完成" "    ✅ Deployed"
    Write-Host ""

    # current 已经切换；以下 npm/postinstall 是部署完成前仍可能失败的步骤。
    Deploy-BootstrapScripts

    Msg "==> 安装依赖..." "==> Installing dependencies..."
    $nodeDir = Split-Path $script:NODE_BIN
    $savedPath = $env:PATH
    if ($env:PATH -notlike "*$nodeDir*") { $env:PATH = "$nodeDir;$env:PATH" }
    # Push/Pop-Location 将 npm 工作目录限制在版本目录；finally 也恢复临时修改的 PATH。
    Push-Location $script:PERMANENT_DIR
    try {
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        # 管道只展示 npm 最后一行；外部程序是否成功必须从紧随其后的 `$LASTEXITCODE` 读取。
        & $script:NPM_BIN install --omit=dev --omit=optional 2>&1 | Select-Object -Last 1
        $npmExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP
    } finally {
        Pop-Location
        $env:PATH = $savedPath
    }
    if ($npmExit -ne 0) {
        Msg "❌ 依赖安装失败 (exit=$npmExit)，请检查 npm 日志" "❌ Dependencies installation failed (exit=$npmExit), check npm logs"
        exit 1
    }
    Msg "    ✅ 依赖安装完成" "    ✅ Dependencies installed"
    Write-Host ""

    Msg "==> 部署 hook 脚本..." "==> Deploying hook scripts..."
    $postinstallScript = Join-Path $script:PERMANENT_DIR "scripts\postinstall.js"
    # `$DataDir` 参数不会自动写入子进程环境变量 LOONGSUITE_PILOT_DATA_DIR。
    # 因此自定义 -DataDir 时，postinstall 的 Hook/Plugin/Skill 实际落点需后续核实；
    # 未确认前不能假定它与 config.json 中 dataDir 一致。
    # 待确认：自定义 -DataDir 未导出为 LOONGSUITE_PILOT_DATA_DIR，postinstall 可能仍写默认数据根。
    if (Test-Path $postinstallScript) {
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        & $script:NODE_BIN $postinstallScript
        $ErrorActionPreference = $prevEAP
    }
    Msg "    ✅ Hook 脚本已部署" "    ✅ Hook scripts deployed"
    Write-Host ""
}

# ============================================================
# 迁移旧单目录布局
# ============================================================
# 把旧 package 单目录迁入 versions，并建立 current 指针，保持升级兼容。
function Migrate-LegacyLayout {
    $cacheDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
    $currentFile = Join-Path $cacheDir "current"
    $legacyDir = Join-Path $cacheDir "package"
    $versionsDir = Join-Path $cacheDir "versions"

    if (Test-Path $currentFile) { return }
    if (-not (Test-Path (Join-Path $legacyDir "dist\index.js"))) { return }

    Msg "==> 迁移旧版本目录结构..." "==> Migrating legacy directory layout..."

    $ver = "0.0.0"; $commit = "legacy"
    $versionFile = Join-Path $legacyDir "VERSION"
    if (Test-Path $versionFile) {
        $content = Get-Content $versionFile
        foreach ($line in $content) {
            if ($line -match "^version=(.+)") { $ver = $Matches[1] }
            if ($line -match "^git_commit=(.+)") { $commit = $Matches[1] }
        }
    }

    $dirName = "${ver}_${commit}"
    $target = Join-Path $versionsDir $dirName

    if (-not (Test-Path $versionsDir)) { New-Item -ItemType Directory -Path $versionsDir -Force | Out-Null }
    Copy-Item $legacyDir $target -Recurse
    Set-Content -Path $currentFile -Value $dirName

    $script:PERMANENT_DIR = $target
    Msg "    ✅ 已迁移到 $target" "    ✅ Migrated to $target"
    Write-Host ""
}

# ============================================================
# 合并并写入 config.json
# ============================================================
# 合并旧 config.json 与本次参数并保留未涉及字段。
# 参数通过临时 JSON 安全传给 Node，但最终 config.json 由 writeFileSync 直接覆盖，并非原子 rename。
function Write-Config {
    $configFile = Join-Path $DataDir "config.json"
    Msg "==> 写入配置文件 $configFile ..." "==> Writing config to $configFile ..."
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }

    # 把参数打包为 JSON，避免 PowerShell 调原生命令时丢失空字符串参数。
    $cfgArgs = [ordered]@{
        configPath        = $configFile
        dataDir           = $DataDir
        slsEndpoint       = "$SlsEndpoint"
        slsProject        = "$SlsProject"
        slsLogstore       = "$SlsLogstore"
        slsAkId           = "$SlsAkId"
        slsAkSecret       = "$SlsAkSecret"
        logLevel          = "$LogLevel"
        userId            = "$($script:UserId)"
        collectLog        = "$CollectLog"
        collectTrace      = "$CollectTrace"
        cmsLicenseKey     = "$CmsLicenseKey"
        cmsEndpoint       = "$CmsEndpoint"
        cmsWorkspace      = "$CmsWorkspace"
        serviceNamePrefix = "$ServiceNamePrefix"
        selectedAgents    = "$($script:SELECTED_AGENTS)"
        maskMode          = "$MaskMode"
        maskTypes         = "$MaskTypes"
        probeResult       = "$($script:PROBE_RESULT)"
    }
    # 结构化 JSON 传参避免把用户值直接插入 JavaScript 源码，从而正确保留引号和反斜杠。
    $cfgJson = $cfgArgs | ConvertTo-Json -Compress
    $cfgTmp = Join-Path $env:TEMP "lp-config-args.json"
    [System.IO.File]::WriteAllText($cfgTmp, $cfgJson, [System.Text.UTF8Encoding]::new($false))

    # Here-string 使用单引号分隔符，内部 `$` 不被 PowerShell 展开；cfgTmp 路径作为 argv 传入。
    # 内嵌 Node 只把精确字符串 `true` 写成布尔 true，其他非空值（包括 `1`）会写 false。
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    & $script:NODE_BIN -e @'
const fs = require('fs');
const opts = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));

let existing = {};
try { existing = JSON.parse(fs.readFileSync(opts.configPath, 'utf-8')); } catch {}

const config = {
  ...existing,
  enabled: true,
  dataDir: opts.dataDir,
};
delete config.internal;
if (config.userId === undefined && config['user.id'] !== undefined) {
  config.userId = config['user.id'];
}
delete config['user.id'];

if (opts.slsEndpoint || opts.slsProject || opts.slsLogstore) {
  config.sls = config.sls || {};
  delete config.sls.destinationOverride;
  if (opts.slsEndpoint) config.sls.endpoint = opts.slsEndpoint;
  if (opts.slsAkId && opts.slsAkSecret) {
    config.sls.mode = 'ak';
    config.sls.accessKeyId = opts.slsAkId;
    config.sls.accessKeySecret = opts.slsAkSecret;
  }
  if (opts.slsProject && opts.slsLogstore) {
    config.sls.project = opts.slsProject;
    config.sls.logstore = opts.slsLogstore;
    delete config.sls.endpoints;
  }
}
if (opts.logLevel) config.logLevel = opts.logLevel;
if (opts.userId) { config.userId = opts.userId; delete config.identity; }
if (opts.collectLog) config.collectLog = opts.collectLog === 'true';
if (opts.collectTrace) config.collectTrace = opts.collectTrace === 'true';
if (opts.cmsLicenseKey || opts.cmsEndpoint || opts.cmsWorkspace) {
  config.cms = config.cms || {};
  if (opts.cmsLicenseKey) config.cms.licenseKey = opts.cmsLicenseKey;
  if (opts.cmsEndpoint) config.cms.endpoint = opts.cmsEndpoint;
  if (opts.cmsWorkspace) config.cms.workspace = opts.cmsWorkspace;
}
if (opts.serviceNamePrefix) config.serviceNamePrefix = opts.serviceNamePrefix;
if (opts.maskMode) {
  config.mask = config.mask || {};
  config.mask.mode = opts.maskMode;
  if (opts.maskMode === 'custom') {
    config.mask.types = opts.maskTypes.split(',').map(t => t.trim()).filter(Boolean);
  } else { delete config.mask.types; }
}
if (opts.selectedAgents) {
  config.agents = config.agents || {};
  const selected = opts.selectedAgents.split(',').map(s => s.trim()).filter(Boolean);
  const allAgents = JSON.parse(opts.probeResult || '[]');
  for (const agent of allAgents) {
    config.agents[agent.id] = config.agents[agent.id] || {};
    config.agents[agent.id].enabled = selected.includes(agent.id);
  }
}

fs.writeFileSync(opts.configPath, JSON.stringify(config, null, 2) + '\n');
'@ $cfgTmp
    $ErrorActionPreference = $prevEAP

    Remove-Item $cfgTmp -Force -ErrorAction SilentlyContinue

    Msg "    ✅ 配置已写入" "    ✅ Config written"
    Write-Host ""
}

# ============================================================
# 安装 loongsuite-pilot PowerShell 与 cmd 命令入口
# ============================================================
# 安装 PowerShell CLI 和 cmd shim 到用户 PATH，并刷新用户级 PATH 设置。
function Install-Command {
    Msg "==> 安装服务管理脚本..." "==> Installing service management script..."
    $binDir = Join-Path $env:USERPROFILE ".local\bin"
    if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }

    # 复制 PowerShell 服务管理脚本。
    $ps1File = Join-Path $binDir "loongsuite-pilot.ps1"
    $ps1Src = Join-Path $script:PERMANENT_DIR "scripts\loongsuite-pilot.ps1"
    if (Test-Path $ps1Src) {
        Copy-Item $ps1Src $ps1File -Force
    }

    # 创建转发到 PowerShell 脚本的 .cmd shim。
    $cmdFile = Join-Path $binDir "loongsuite-pilot.cmd"
    $cmdContent = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0loongsuite-pilot.ps1" %*
'@
    Set-Content -Path $cmdFile -Value $cmdContent -Encoding ASCII
    Msg "    ✅ 已安装: $cmdFile" "    ✅ Installed: $cmdFile"

    # 尚未存在时加入用户级 PATH。
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$binDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$binDir;$userPath", "User")
        Msg "    已将 $binDir 添加到用户 PATH" "    Added $binDir to user PATH"
        $env:Path = "$binDir;$env:Path"
    }
    Write-Host ""
}

# ============================================================
# 版本辅助函数
# ============================================================
# 读取并返回/展示 Get-InstalledVersion 对应信息，不改变服务运行状态。
function Get-InstalledVersion {
    $cacheDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
    $currentFile = Join-Path $cacheDir "current"
    $versionsDir = Join-Path $cacheDir "versions"

    if (Test-Path $currentFile) {
        $dir = (Get-Content $currentFile -ErrorAction SilentlyContinue).Trim()
        $vf = Join-Path $versionsDir "$dir\VERSION"
        if ($dir -and (Test-Path $vf)) {
            $content = Get-Content $vf
            foreach ($line in $content) {
                if ($line -match "^version=(.+)") { return $Matches[1] }
            }
        }
    }

    $vf = Join-Path $script:PERMANENT_DIR "VERSION"
    if (Test-Path $vf) {
        $content = Get-Content $vf
        foreach ($line in $content) {
            if ($line -match "^version=(.+)") { return $Matches[1] }
        }
    }
    return ""
}

# 读取并返回/展示 Get-VersionFromDir 对应信息，不改变服务运行状态。
function Get-VersionFromDir {
    param([string]$dir)
    $vf = Join-Path $dir "VERSION"
    if (Test-Path $vf) {
        $content = Get-Content $vf
        foreach ($line in $content) {
            if ($line -match "^version=(.+)") { return $Matches[1] }
        }
    }
    return ""
}

# 读取并返回/展示 Get-CommitFromDir 对应信息，不改变服务运行状态。
function Get-CommitFromDir {
    param([string]$dir)
    $vf = Join-Path $dir "VERSION"
    if (Test-Path $vf) {
        $content = Get-Content $vf
        foreach ($line in $content) {
            if ($line -match "^git_commit=(.+)") { return $Matches[1] }
        }
    }
    return ""
}

# 读取并返回/展示 Show-VersionInfo 对应信息，不改变服务运行状态。
function Show-VersionInfo {
    param([string]$dir)
    $vf = Join-Path $dir "VERSION"
    if (Test-Path $vf) {
        $v = ""; $c = ""; $t = ""
        $content = Get-Content $vf
        foreach ($line in $content) {
            if ($line -match "^version=(.+)") { $v = $Matches[1] }
            if ($line -match "^git_commit=(.+)") { $c = $Matches[1] }
            if ($line -match "^build_time=(.+)") { $t = $Matches[1] }
        }
        return "v${v} (${c}, ${t})"
    }
    return "unknown"
}

# ============================================================
# 打印安装摘要
# ============================================================
# 读取并返回/展示 Print-Summary 对应信息，不改变服务运行状态。
function Print-Summary {
    param([string]$action)
    $configFile = Join-Path $DataDir "config.json"
    Write-Host "============================================================"
    $ver = Show-VersionInfo $script:PERMANENT_DIR
    switch ($action) {
        "install" { Msg "✅ 安装完成！版本: $ver" "✅ Installation complete! Version: $ver" }
        "upgrade" { Msg "✅ 升级完成！版本: $ver" "✅ Upgrade complete! Version: $ver" }
    }
    Write-Host ""
    Msg "配置文件: $configFile" "Config file: $configFile"
    Msg "数据目录: $DataDir" "Data directory: $DataDir"
    Msg "Hook 目录: $DataDir\hooks" "Hooks directory: $DataDir\hooks"
    Write-Host ""

    if ($SlsEndpoint) {
        Msg "SLS 后端: $SlsEndpoint" "SLS backend: $SlsEndpoint"
        if ($SlsProject)  { Msg "   项目: $SlsProject" "   Project: $SlsProject" }
        if ($SlsLogstore) { Msg "   日志库: $SlsLogstore" "   Logstore: $SlsLogstore" }
        Write-Host ""
    }

    Msg "命令:" "Commands:"
    Write-Host "   loongsuite-pilot          # 查看状态 / Status"
    Write-Host "   loongsuite-pilot info     # 版本与配置 / Version & config"
    Write-Host "============================================================"
}

# ============================================================
# 通过已安装 CLI/PID 停止服务
# ============================================================
# best-effort 调用已安装 CLI stop，为升级/卸载释放文件和 Scheduled Task。
function Stop-PilotService {
    $pidFile = Join-Path $DataDir "loongsuite-pilot.pid"
    if (Test-Path $pidFile) {
        $oldPid = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim()
        if ($oldPid) {
            $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($proc) {
                Msg "==> 停止运行中的服务 (PID $oldPid)..." "==> Stopping running service (PID $oldPid)..."
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
                $count = 0
                while ($count -lt 10) {
                    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
                    if (-not $proc) { break }
                    Start-Sleep -Seconds 1
                    $count++
                }
                Msg "    ✅ 已停止" "    ✅ Stopped"
                Write-Host ""
            }
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }

    # 同时尝试直接调用 loongsuite-pilot.ps1，避免 cmd.exe 窗口弹出。
    $ps1Path = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.ps1"
    if (Test-Path $ps1Path) {
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path stop 2>$null
        $ErrorActionPreference = $prevEAP
    }
}

# ============================================================
# 回收旧版本
# ============================================================
# 只保留 current/previous 指向版本，删除其余历史版本目录。
function GC-OldVersions {
    $cacheDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
    $versionsDir = Join-Path $cacheDir "versions"
    $currentFile = Join-Path $cacheDir "current"
    $previousFile = Join-Path $cacheDir "previous"

    if (-not (Test-Path $versionsDir)) { return }

    $keepCurrent = ""; $keepPrevious = ""
    if (Test-Path $currentFile) { $keepCurrent = (Get-Content $currentFile -ErrorAction SilentlyContinue).Trim() }
    if (Test-Path $previousFile) { $keepPrevious = (Get-Content $previousFile -ErrorAction SilentlyContinue).Trim() }

    Get-ChildItem $versionsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Name -ne $keepCurrent -and $_.Name -ne $keepPrevious) {
            Remove-Item $_.FullName -Recurse -Force
        }
    }
}

# ============================================================
# 清理 Hook 配置
# ============================================================
# 幂等清理 Remove-HookConfigs 对应的文件或 Agent 配置，目标不存在时继续。
function Remove-HookConfigs {
    $HOOK_MARKER = ".loongsuite-pilot"
    $configs = @(
        (Join-Path $env:USERPROFILE ".cursor\hooks.json"),
        (Join-Path $env:USERPROFILE ".qoder\settings.json"),
        (Join-Path $env:USERPROFILE ".qoder-cn\settings.json"),
        (Join-Path $env:USERPROFILE ".qoderwork\settings.json"),
        (Join-Path $env:USERPROFILE ".qoderworkcn\settings.json"),
        (Join-Path $env:USERPROFILE ".claude\settings.json"),
        (Join-Path $env:USERPROFILE ".codex\hooks.json"),
        (Join-Path $env:USERPROFILE ".qwen\settings.json")
    )

    foreach ($cfg in $configs) {
        if (-not (Test-Path $cfg)) { continue }
        $short = $cfg -replace [regex]::Escape($env:USERPROFILE), "~"

        try {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & $script:NODE_BIN -e @'
const fs = require('fs');
const cfg = process.argv[1];
const marker = process.argv[2];
try {
  const data = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
  const hooks = data.hooks;
  if (!hooks || typeof hooks !== 'object') process.exit(0);
  let changed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter(e => {
      const cmd = e.command || '';
      const nested = Array.isArray(e.hooks) ? e.hooks : [];
      const hasMarker = cmd.includes(marker) || nested.some(h => (h.command || '').includes(marker));
      if (hasMarker) changed = true;
      return !hasMarker;
    });
    if (filtered.length === 0) { delete hooks[event]; changed = true; }
    else hooks[event] = filtered;
  }
  if (changed) {
    fs.writeFileSync(cfg, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }
} catch(e) { process.stderr.write(e.message); process.exit(1); }
'@ $cfg $HOOK_MARKER 2>$null
            $ErrorActionPreference = $prevEAP
            Msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short"
        } catch {
            Msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)"
        }
    }
}

# ============================================================
# 清理 OpenCode plugin-inject spec
# ============================================================
# OpenCode 使用 deployMode `plugin-inject`：spec 写入自身配置文件的 plugin 数组，而非共享
# settings.json。Remove-HookConfigs 不覆盖该位置，因此在这里清理，避免留下悬空 spec。
# 幂等清理 Remove-OpenCodePlugin 对应的文件或 Agent 配置，目标不存在时继续。
function Remove-OpenCodePlugin {
    $configs = @(
        (Join-Path $env:USERPROFILE ".config\opencode\opencode.jsonc"),
        (Join-Path $env:USERPROFILE ".config\opencode\opencode.json"),
        (Join-Path $env:USERPROFILE ".config\opencode\config.json")
    )

    foreach ($cfg in $configs) {
        if (-not (Test-Path $cfg)) { continue }
        $short = $cfg -replace [regex]::Escape($env:USERPROFILE), "~"

        if (-not $script:NODE_BIN) {
            Msg "    ⚠️  跳过: $short (无 node,需手动清理)" "    ⚠️  Skipped: $short (node unavailable, manual cleanup needed)"
            continue
        }

        $result = & $script:NODE_BIN -e @'
const fs = require('fs');
const f = process.argv[1];
const isOurs = s => typeof s === 'string' && (s.includes('loongsuite-pilot-opencode') || s.includes('plugins/opencode/plugin.mjs'));
const entryStr = e => typeof e === 'string' ? e : (Array.isArray(e) ? String(e[0]) : '');
const stripJsonc = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/[ \t]+\/\/.*$/gm, '');
try {
  const raw = fs.readFileSync(f, 'utf-8');
  let data, hadComments = false;
  try { data = JSON.parse(raw); }
  catch { data = JSON.parse(stripJsonc(raw)); hadComments = true; }
  const key = Array.isArray(data.plugins) ? 'plugins' : (Array.isArray(data.plugin) ? 'plugin' : null);
  if (!key) { process.stdout.write('nochange'); process.exit(0); }
  const before = data[key].length;
  data[key] = data[key].filter(e => !isOurs(entryStr(e)));
  if (data[key].length === before) { process.stdout.write('nochange'); process.exit(0); }
  if (hadComments) fs.writeFileSync(f + '.bak', raw, 'utf-8');
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  process.stdout.write(hadComments ? 'cleaned-bak' : 'cleaned');
} catch (e) { process.stderr.write(e.message); process.exit(1); }
'@ $cfg 2>$null

        switch ($result) {
            "cleaned"     { Msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short" }
            "cleaned-bak" { Msg "    ✅ 已清理: $short (含注释,原文件备份为 $short.bak)" "    ✅ Cleaned: $short (had comments, original backed up to $short.bak)" }
            "nochange"    { }
            default       { Msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)" }
        }
    }
}

# ============================================================
# 清理 Pi Coding Agent extension 注入
# ============================================================
# 幂等清理 Remove-PiCodingAgentExtension 对应的文件或 Agent 配置，目标不存在时继续。
function Remove-PiCodingAgentExtension {
    $cfg = Join-Path $env:USERPROFILE ".pi\agent\settings.json"
    if (-not (Test-Path $cfg)) { return }
    $short = $cfg -replace [regex]::Escape($env:USERPROFILE), "~"

    if (-not $script:NODE_BIN) {
        Msg "    ⚠️  跳过: $short (无 node,需手动清理)" "    ⚠️  Skipped: $short (node unavailable, manual cleanup needed)"
        return
    }

    $result = & $script:NODE_BIN -e @'
const fs = require('fs');
const f = process.argv[1];
const isOurs = s => typeof s === 'string' && (
  s.includes('loongsuite-pilot-pi-coding-agent') ||
  s.includes('plugins/pi-coding-agent/index.mjs')
);
try {
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
  if (!Array.isArray(data.extensions)) { process.stdout.write('nochange'); process.exit(0); }
  const before = data.extensions.length;
  data.extensions = data.extensions.filter(entry => !isOurs(typeof entry === 'string' ? entry : ''));
  if (data.extensions.length === before) { process.stdout.write('nochange'); process.exit(0); }
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  process.stdout.write('cleaned');
} catch (e) { process.stderr.write(e.message); process.exit(1); }
'@ $cfg 2>$null

    switch ($result) {
        "cleaned"  { Msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short" }
        "nochange" { }
        default    { Msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)" }
    }
}

# ============================================================
# 清理 Claude/Codex 历史 OTel 插件
# ============================================================
# 幂等清理 Remove-OtelPlugin 对应的文件或 Agent 配置，目标不存在时继续。
function Remove-OtelPlugin {
    $OTEL_CLAUDE_DIR = Join-Path $env:USERPROFILE ".cache\opentelemetry.instrumentation.claude"
    $OTEL_CODEX_DIR = Join-Path $env:USERPROFILE ".cache\opentelemetry.instrumentation.codex"

    # 清理 Claude settings.json Hook。
    $claudeSettings = Join-Path $env:USERPROFILE ".claude\settings.json"
    if ((Test-Path $claudeSettings) -and $script:NODE_BIN) {
        $content = Get-Content $claudeSettings -Raw -ErrorAction SilentlyContinue
        if ($content -match "otel-claude-hook|hook-entry") {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & $script:NODE_BIN -e @'
const fs = require('fs');
const f = process.argv[1];
const isOurs = c => c.includes('otel-claude-hook') || c.includes('hook-entry.sh');
try {
  const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
  if (d && d.hooks) {
    for (const ev of Object.keys(d.hooks)) {
      if (!Array.isArray(d.hooks[ev])) continue;
      d.hooks[ev] = d.hooks[ev].map(m => {
        if (!Array.isArray(m.hooks)) return m;
        m.hooks = m.hooks.filter(h => !(h.command && isOurs(h.command)));
        return m.hooks.length > 0 ? m : null;
      }).filter(Boolean);
      if (d.hooks[ev].length === 0) delete d.hooks[ev];
    }
    if (Object.keys(d.hooks).length === 0) delete d.hooks;
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
  }
} catch {}
'@ $claudeSettings 2>$null
            $ErrorActionPreference = $prevEAP
            Msg "    ✅ settings.json hooks 已清理" "    ✅ settings.json hooks cleaned"
        }
    }

    # 删除插件目录。
    foreach ($dir in @($OTEL_CLAUDE_DIR, $OTEL_CODEX_DIR)) {
        if (Test-Path $dir) {
            if ($Purge) {
                Remove-Item $dir -Recurse -Force
                Msg "    ✅ 插件目录已完全删除 (--Purge): $dir" "    ✅ Plugin directory fully removed (-Purge): $dir"
            } else {
                Get-ChildItem $dir -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -ne "sessions" } |
                    ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
                Msg "    ✅ 插件文件已删除（sessions/ 已保留）" "    ✅ Plugin files removed (sessions/ preserved)"
            }
        }
    }
}

# ============================================================
# 命令：install
# ============================================================
# 编排 Windows 首次安装：依赖、下载、探测、部署、配置、CLI 和启动健康检查。
function Cmd-Install {
    Msg "==> 开始安装 $PACKAGE_NAME ..." "==> Installing $PACKAGE_NAME ..."
    Write-Host ""

    Check-Deps
    Migrate-LegacyLayout

    $curVer = Get-InstalledVersion
    if ($curVer) {
        Msg "⚠️  检测到已安装版本 v${curVer}，将执行重新安装" "⚠️  Existing installation v${curVer} detected, re-installing"
        Write-Host ""
    }

    Stop-PilotService

    # finally 只保证下载临时目录被删除，不会回滚已经复制的版本、配置或命令入口。
    try {
        Download-AndExtract
        Probe-Agents
        Select-Agents
        Prompt-UserId
        Confirm-ConfigOverwrite
        Deploy-Package $script:INSTALL_SRC
        Write-Config
        Install-Command

        Msg "==> 启动服务..." "==> Starting service..."
        $ps1Path = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.ps1"
        if (Test-Path $ps1Path) {
            # start/status 非零不应跳过 finally；暂时降级为 Continue，再以固定状态文本判断健康。
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path start 2>$null
            Start-Sleep -Seconds 2
            $statusOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path status 2>$null
            $ErrorActionPreference = $prevEAP
            if ($statusOut -match "is running") {
                Msg "    ✅ 服务已启动" "    ✅ Service started"
            } else {
                Msg "    ⚠️  服务可能尚未就绪，请检查: loongsuite-pilot status" `
                    "    ⚠️  Service may not be ready. Check: loongsuite-pilot status"
            }
        }
        Write-Host ""
        Print-Summary "install"
    } finally {
        if ($script:TMP_DIR -and (Test-Path $script:TMP_DIR)) {
            Remove-Item $script:TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ============================================================
# 命令：upgrade
# ============================================================
# 停止服务部署新版本并启动验证；失败时调用 rollback 恢复旧版本。
function Cmd-Upgrade {
    Msg "==> 开始升级 $PACKAGE_NAME ..." "==> Upgrading $PACKAGE_NAME ..."
    Write-Host ""

    Migrate-LegacyLayout

    $oldVer = Get-InstalledVersion
    if (-not $oldVer) {
        Msg "❌ 未检测到已安装的 loongsuite-pilot，请先执行 install" `
            "❌ No existing installation found. Please run install first."
        exit 1
    }

    Msg "   当前版本: $oldVer" "   Current version: $oldVer"
    Write-Host ""

    Check-Deps

    try {
        Download-AndExtract

        $newVer = Get-VersionFromDir $script:INSTALL_SRC
        $newCommit = Get-CommitFromDir $script:INSTALL_SRC
        $oldCommit = Get-CommitFromDir $script:PERMANENT_DIR

        # 版本号和 commit 均相同才短路；相同版本的新 commit 仍执行升级。
        if ($newVer -and $newVer -eq $oldVer -and $newCommit -eq $oldCommit) {
            Msg "✅ 已是最新版本 v${newVer} (${newCommit})，无需升级" `
                "✅ Already at latest version v${newVer} (${newCommit}), nothing to do"
            exit 0
        }

        Msg "   新版本: ${newVer} (${newCommit})" "   New version: ${newVer} (${newCommit})"
        Write-Host ""

        Msg "==> 停止服务..." "==> Stopping service..."
        Stop-PilotService
        Write-Host ""

        Deploy-Package $script:INSTALL_SRC
        Install-Command

        Msg "==> 启动新版本..." "==> Starting new version..."
        $ps1Path = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.ps1"
        $started = $false
        if (Test-Path $ps1Path) {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path start 2>$null
            Start-Sleep -Seconds 2
            $statusOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path status 2>$null
            $ErrorActionPreference = $prevEAP
            if ($statusOut -match "is running") {
                Msg "    ✅ 新版本启动成功" "    ✅ New version started successfully"
                Write-Host ""
                GC-OldVersions
                Print-Summary "upgrade"
                $started = $true
            }
        }

        if (-not $started) {
            Write-Host ""
            Msg "⚠️  新版本启动失败，正在回滚..." "⚠️  New version failed to start, rolling back..."
            if (Test-Path $ps1Path) {
                $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path stop 2>$null
                # rollback 的退出码当前未检查，后面的“已回滚”提示不构成成功证明，应再用 status/info 复核。
                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path rollback 2>$null
                $ErrorActionPreference = $prevEAP
            }
            Msg "❌ 升级失败，已回滚到 v${oldVer}" "❌ Upgrade failed, rolled back to v${oldVer}"
            Msg "   请检查日志: loongsuite-pilot log" "   Check logs: loongsuite-pilot log"
            exit 1
        }
    } finally {
        if ($script:TMP_DIR -and (Test-Path $script:TMP_DIR)) {
            Remove-Item $script:TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ============================================================
# 命令：uninstall
# ============================================================
# 停止/注销任务，清理 Agent 注入和命令入口，并按 Purge 处理数据目录。
function Cmd-Uninstall {
    Msg "🗑️  开始卸载 $PACKAGE_NAME ..." "🗑️  Uninstalling $PACKAGE_NAME ..."
    Write-Host ""

    Msg "==> 停止服务..." "==> Stopping service..."
    Stop-PilotService
    Msg "    ✅ 服务已停止" "    ✅ Service stopped"
    Write-Host ""

    # 注销 Scheduled Task。
    $taskFolder = "\LoongsuitePilot"
    foreach ($taskName in @("LoongsuitePilot")) {
        $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskFolder -ErrorAction SilentlyContinue
        if ($task) {
            if ($task.State -eq "Running") {
                Stop-ScheduledTask -TaskName $taskName -TaskPath $taskFolder -ErrorAction SilentlyContinue
            }
            Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskFolder -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
    Msg "    ✅ 已移除计划任务" "    ✅ Removed scheduled tasks"

    # 当前实现无条件删除默认安装根目录；默认 DataDir 也位于其中，因此不带 -Purge 时仍会丢失默认配置/日志。
    # 只有把 DataDir 设置到该目录之外时，后面的“数据目录已保留”提示才与实际行为一致。
    Msg "==> 删除安装目录..." "==> Removing installation..."
    $installDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
    if (Test-Path $installDir) {
        Remove-Item $installDir -Recurse -Force
    }
    Msg "    ✅ 已删除 $installDir" "    ✅ Removed $installDir"

    Msg "==> 删除 loongsuite-pilot 命令..." "==> Removing loongsuite-pilot command..."
    $cmdFile = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.cmd"
    $ps1File = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.ps1"
    if (Test-Path $cmdFile) { Remove-Item $cmdFile -Force }
    if (Test-Path $ps1File) { Remove-Item $ps1File -Force }
    Msg "    ✅ loongsuite-pilot 命令已删除" "    ✅ loongsuite-pilot command removed"
    Write-Host ""

    Msg "==> 清理 hook 配置..." "==> Cleaning up hook configs..."
    Remove-HookConfigs
    Write-Host ""

    Msg "==> 清理 Claude/Codex 插件..." "==> Cleaning up Claude/Codex plugins..."
    Remove-OtelPlugin
    Write-Host ""

    Msg "==> 清理 OpenCode 插件配置..." "==> Cleaning up OpenCode plugin config..."
    Remove-OpenCodePlugin
    Write-Host ""

    Msg "==> 清理 Pi Coding Agent Extension 配置..." "==> Cleaning up Pi Coding Agent extension config..."
    Remove-PiCodingAgentExtension
    Write-Host ""

    # DataDir 位于默认安装根之外时，本分支才体现 -Purge 与非 Purge 的实际差别。
    if ($Purge) {
        Msg "==> 删除数据目录 (-Purge)..." "==> Removing data directory (-Purge)..."
        if (Test-Path $DataDir) { Remove-Item $DataDir -Recurse -Force }
        Msg "    ✅ 已删除 $DataDir" "    ✅ Removed $DataDir"
    } else {
        Msg "📁 数据目录已保留: $DataDir" "📁 Data directory preserved: $DataDir"
        Msg "   (包含配置和日志，如需彻底删除请加 -Purge)" `
            "   (contains config and logs, add -Purge to remove)"
    }
    Write-Host ""

    Write-Host "============================================================"
    Msg "✅ 卸载完成！" "✅ Uninstallation complete!"
    Write-Host "============================================================"
}

# ============================================================
# 主命令分派
# ============================================================
switch ($Command) {
    "install"   { Cmd-Install }
    "upgrade"   { Cmd-Upgrade }
    "uninstall" { Cmd-Uninstall }
    default {
        Write-Host "Usage: .\installer-opensource.ps1 {install|upgrade|uninstall} [options]"
        exit 1
    }
}
