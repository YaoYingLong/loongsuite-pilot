#!/usr/bin/env bash
# 开源版本发布入口：计算/写入版本、创建 release 分支和 tag、推送 Git，并上传 OSS 产物。
# GitHub Actions 在 tag 推送后创建 GitHub Release；`--oss-only` 则跳过全部 Git 写操作。
#
# 用法：
#   bash deploy/release-opensource.sh                    # 默认递增 patch
#   bash deploy/release-opensource.sh --patch            # 与默认行为相同
#   bash deploy/release-opensource.sh --minor            # 递增 minor（1.0.x → 1.1.0）
#   bash deploy/release-opensource.sh --major            # 递增 major（1.x.x → 2.0.0）
#   bash deploy/release-opensource.sh --version 1.2.3    # 显式指定版本
#   bash deploy/release-opensource.sh --dry-run          # 只展示动作，不写 Git/OSS
#   bash deploy/release-opensource.sh --oss-only         # 只构建、打包、上传 OSS
#
# 流程：拉取 tag → 计算版本 → 从 origin/main 建分支 → 更新 package.json → commit/tag/push
# → 调用 `package-opensource.sh` 构建 tar.gz/zip → ossutil 上传版本/latest/安装器。
# 外部依赖包括 git、node、bash、ossutil；任何未被显式捕获的失败都会因严格模式终止发布。

# `env bash` 按 PATH 选择 Bash；`-euo pipefail` 分别表示失败即退出、未定义变量报错、
# 管道中任一命令失败即使整个管道失败，避免发布到一半仍继续上传。
set -euo pipefail

# `BASH_SOURCE[0]` 指向当前脚本；两次 cd/pwd 得到不受调用者工作目录影响的绝对项目根目录。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BUMP_TYPE="patch"
EXPLICIT_VERSION=""
DRY_RUN=0
SKIP_OSS=0
OSS_ONLY=0

OSS_BUCKET="oss://loongcollector-community-edition"
OSS_PREFIX="loongsuite-pilot"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --patch)          BUMP_TYPE="patch"; shift ;;
        --minor)          BUMP_TYPE="minor"; shift ;;
        --major)          BUMP_TYPE="major"; shift ;;
        --version)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --version requires a value" >&2; exit 1
            fi
            EXPLICIT_VERSION="$2"; shift 2 ;;
        --version=*)      EXPLICIT_VERSION="${1#*=}"; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        --skip-oss)       SKIP_OSS=1; shift ;;
        --oss-only)       OSS_ONLY=1; shift ;;
        *)
            echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

cd "$PROJECT_ROOT"

PACKAGE_NAME="loongsuite-pilot"

# ── 校验语义版本格式 ──
validate_semver() {
    if [[ ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "❌ Invalid version format: $1 (expected X.Y.Z)" >&2
        exit 1
    fi
}

# ── 解析目标版本 ──
if [ "$OSS_ONLY" -eq 1 ]; then
    # `--oss-only` 使用显式版本，否则读取当前 package.json.version。
    if [ -n "$EXPLICIT_VERSION" ]; then
        NEXT_VERSION="$EXPLICIT_VERSION"
    else
        NEXT_VERSION=$(node -e "process.stdout.write(require('./package.json').version)")
    fi
    validate_semver "$NEXT_VERSION"

    echo "==> OSS-only mode"
    echo "    Version: ${NEXT_VERSION}"
    echo ""

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry-run] Would build, package, and upload to OSS:"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.tar.gz"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.zip"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.tar.gz"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.zip"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/installer.sh"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/installer.ps1"
        exit 0
    fi
else
    # 完整发布先确认工作树干净，再从远端 tag 计算版本。
    if [ -n "$(git status --porcelain)" ]; then
        echo "❌ Working tree is not clean. Please commit or stash changes first."
        git status --short
        exit 1
    fi

    echo "==> Fetching from remote..."
    git fetch origin --prune --prune-tags --quiet
    echo "    ✅ Synced tags and branches"

    get_latest_version_from_tags() {
        local latest
        latest=$(git tag -l 'v*' --sort=-v:refname | head -1 | sed 's/^v//')
        if [ -z "$latest" ]; then
            latest=$(node -e "process.stdout.write(require('./package.json').version)")
        fi
        echo "$latest"
    }

    bump_version() {
        local current="$1" type="$2"
        local major minor patch
        IFS='.' read -r major minor patch <<< "$current"
        case "$type" in
            major) echo "$((major + 1)).0.0" ;;
            minor) echo "${major}.$((minor + 1)).0" ;;
            patch) echo "${major}.${minor}.$((patch + 1))" ;;
        esac
    }

    CURRENT_VERSION=$(get_latest_version_from_tags)

    if [ -n "$EXPLICIT_VERSION" ]; then
        NEXT_VERSION="$EXPLICIT_VERSION"
    else
        NEXT_VERSION=$(bump_version "$CURRENT_VERSION" "$BUMP_TYPE")
    fi

    validate_semver "$NEXT_VERSION"

    RELEASE_BRANCH="release/v${NEXT_VERSION}"

    echo "==> Version"
    echo "    Current: ${CURRENT_VERSION}"
    echo "    Next:    ${NEXT_VERSION} (${BUMP_TYPE})"
    echo "    Branch:  ${RELEASE_BRANCH}"
    echo ""

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry-run] Would create branch: ${RELEASE_BRANCH} from origin/main"
        echo "[dry-run] Would update package.json: ${CURRENT_VERSION} → ${NEXT_VERSION}"
        echo "[dry-run] Would commit and tag: v${NEXT_VERSION}"
        echo "[dry-run] Would push tag → GitHub Actions creates the Release"
        echo "[dry-run] Would build, package, and upload to OSS:"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.tar.gz"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.zip"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.tar.gz"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.zip"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/installer.sh"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/installer.ps1"
        exit 0
    fi

    # ── 发布确认 ──
    read -r -p "Proceed with release v${NEXT_VERSION}? [y/N] " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi

    # ── 从 origin/main 创建 release 分支 ──
    echo "==> Creating release branch..."
    if git show-ref --verify --quiet "refs/heads/${RELEASE_BRANCH}"; then
        echo "    Branch ${RELEASE_BRANCH} already exists locally, switching to it"
        git checkout "${RELEASE_BRANCH}"
    else
        git checkout -b "${RELEASE_BRANCH}" origin/main
    fi
    echo "    ✅ On branch ${RELEASE_BRANCH}"

    # ── 更新 package.json ──
    echo "==> Updating package.json..."
    NEXT_VERSION="$NEXT_VERSION" node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = process.env.NEXT_VERSION;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
    echo "    ✅ package.json → ${NEXT_VERSION}"

    # ── 创建 commit 与 tag ──
    echo "==> Committing and tagging..."
    git add package.json
    if git diff --cached --quiet; then
        echo "    ⏭️  No changes to commit (version already ${NEXT_VERSION})"
    else
        git commit -m "release: v${NEXT_VERSION}"
    fi
    if git rev-parse "v${NEXT_VERSION}" >/dev/null 2>&1; then
        echo "    ⏭️  Tag v${NEXT_VERSION} already exists"
    else
        git tag -a "v${NEXT_VERSION}" -m "Release v${NEXT_VERSION}"
        echo "    ✅ Tagged v${NEXT_VERSION}"
    fi

    # ── 推送分支和 tag ──
    echo ""
    echo "==> Pushing to remote..."
    git push origin "${RELEASE_BRANCH}" "v${NEXT_VERSION}" -u
    echo "    ✅ Pushed branch ${RELEASE_BRANCH} and tag v${NEXT_VERSION}"
fi

if [ "$SKIP_OSS" -eq 0 ]; then
    echo ""
    echo "==> Building and packaging..."
    bash deploy/package-opensource.sh
    TARBALL="$PROJECT_ROOT/${PACKAGE_NAME}.tar.gz"
    ZIPFILE="$PROJECT_ROOT/${PACKAGE_NAME}.zip"

    if [ ! -f "$TARBALL" ]; then
        echo "❌ Package file not found: $TARBALL"
        exit 1
    fi
    if [ ! -f "$ZIPFILE" ]; then
        echo "❌ Package file not found: $ZIPFILE"
        exit 1
    fi

    if ! command -v ossutil &>/dev/null; then
        echo "❌ ossutil not found. Install it or use --skip-oss to skip OSS upload."
        exit 1
    fi

    echo ""
    echo "==> Uploading to OSS..."

    # 上传带版本路径的 Linux/macOS tar.gz 与 Windows zip。
    ossutil cp "$TARBALL" "${OSS_BUCKET}/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.tar.gz" -f
    echo "    ✅ ${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.tar.gz"

    ossutil cp "$ZIPFILE" "${OSS_BUCKET}/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.zip" -f
    echo "    ✅ ${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.zip"

    # 同时覆盖 latest 下载路径。
    ossutil cp "$TARBALL" "${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.tar.gz" -f
    echo "    ✅ ${OSS_PREFIX}/latest/${PACKAGE_NAME}.tar.gz"

    ossutil cp "$ZIPFILE" "${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.zip" -f
    echo "    ✅ ${OSS_PREFIX}/latest/${PACKAGE_NAME}.zip"

    # 上传 Linux/macOS Shell 与 Windows PowerShell 安装器。
    ossutil cp deploy/installer-opensource.sh "${OSS_BUCKET}/${OSS_PREFIX}/installer.sh" -f
    echo "    ✅ ${OSS_PREFIX}/installer.sh"

    ossutil cp deploy/installer-opensource.ps1 "${OSS_BUCKET}/${OSS_PREFIX}/installer.ps1" -f
    echo "    ✅ ${OSS_PREFIX}/installer.ps1"

    # 清理本地临时构建产物。
    rm -f "$TARBALL" "$ZIPFILE"
else
    echo ""
    echo "==> Skipping OSS upload (--skip-oss)"
fi

# ── 发布完成 ──
echo ""
echo "============================================================"
if [ "$OSS_ONLY" -eq 1 ]; then
    echo "✅ OSS upload v${NEXT_VERSION} complete!"
else
    echo "✅ Release v${NEXT_VERSION} complete!"
    echo ""
    echo "   Tag:     v${NEXT_VERSION}"
    echo "   Branch:  ${RELEASE_BRANCH}"
fi
echo ""
echo "   OSS:     https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.tar.gz (Linux/macOS)"
echo "            https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.zip (Windows)"
if [ "$OSS_ONLY" -eq 0 ]; then
    echo "   GitHub Actions will create the GitHub Release."
    echo "   Next step: create PR to merge ${RELEASE_BRANCH} → main"
fi
echo "============================================================"
