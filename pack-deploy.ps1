#Requires -Version 5.0
<#
.SYNOPSIS
    打包 bb-transform 项目用于服务器 docker compose 部署所需的文件到部署目录。

.DESCRIPTION
    基于项目根目录的 Dockerfile 与 docker-compose.yml 构建上下文需求，
    把运行 docker compose 所需的文件复制到根目录下的部署目录。

    每次运行都会：
      1. 删除部署目录下所有原有文件（整个目录重建）；
      2. 重新创建部署目录；
      3. 复制所需的文件与目录。

    复制目录时会排除 node_modules（减小传输体积，镜像构建时由 npm install 重新安装）。

.PARAMETER DeployDir
    部署目录名称（位于项目根目录下），默认为 "部署"。

.EXAMPLE
    .\pack-deploy.ps1
    使用默认部署目录 "部署"。

.EXAMPLE
    .\pack-deploy.ps1 -DeployDir my-deploy
    使用自定义部署目录 "my-deploy"。
#>

param(
    [string]$DeployDir = "部署"
)

$ErrorActionPreference = "Stop"

# 脚本所在目录即为项目根目录
$ProjectRoot = $PSScriptRoot
$DeployPath  = Join-Path $ProjectRoot $DeployDir

Write-Host "==> 项目根目录: $ProjectRoot" -ForegroundColor Cyan
Write-Host "==> 部署目录:   $DeployPath" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------------
# 1. 删除原有部署目录并重建（保证每次都是干净的全新打包）
# ---------------------------------------------------------------------------
if (Test-Path $DeployPath) {
    Write-Host "==> 删除原有部署目录..." -ForegroundColor Yellow
    Remove-Item -Path $DeployPath -Recurse -Force
}
Write-Host "==> 创建部署目录..." -ForegroundColor Green
New-Item -Path $DeployPath -ItemType Directory -Force | Out-Null

# ---------------------------------------------------------------------------
# 2. 需要复制的文件清单（Dockerfile 构建上下文所依赖的顶层文件）
# ---------------------------------------------------------------------------
$Files = @(
    "Dockerfile",
    "docker-compose.yml",
    ".dockerignore",
    "index.html",
    "styles.css",
    "app.js"
)

# ---------------------------------------------------------------------------
# 3. 需要复制的目录清单（保留原结构，排除 node_modules）
# ---------------------------------------------------------------------------
$Dirs = @(
    "core",
    "vendor",
    "server"
)

# ---------------------------------------------------------------------------
# 4. 复制单个文件
# ---------------------------------------------------------------------------
Write-Host "==> 复制文件..." -ForegroundColor Green
foreach ($file in $Files) {
    $src = Join-Path $ProjectRoot $file
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination $DeployPath -Force
        Write-Host "    [文件] $file" -ForegroundColor DarkGray
    } else {
        Write-Warning "    跳过（不存在）: $file"
    }
}

# ---------------------------------------------------------------------------
# 5. 复制目录（使用 robocopy，排除 node_modules）
#    robocopy 退出码 < 8 均视为成功
# ---------------------------------------------------------------------------
Write-Host "==> 复制目录..." -ForegroundColor Green
foreach ($dir in $Dirs) {
    $src = Join-Path $ProjectRoot $dir
    if (Test-Path $src) {
        $dest = Join-Path $DeployPath $dir
        robocopy $src $dest /E /XD node_modules .git /NJH /NJS /NFL /NDL /NP /R:1 /W:1 | Out-Null
        if ($LASTEXITCODE -ge 8) {
            throw "robocopy 复制目录失败: $dir (退出码 $LASTEXITCODE)"
        }
        # 重置 LASTEXITCODE，避免误判后续逻辑
        $global:LASTEXITCODE = 0
        Write-Host "    [目录] $dir" -ForegroundColor DarkGray
    } else {
        Write-Warning "    跳过（不存在）: $dir"
    }
}

# ---------------------------------------------------------------------------
# 6. 完成
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==> 打包完成！" -ForegroundColor Green
Write-Host "    部署目录: $DeployPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "    传输到服务器后，在该目录执行:" -ForegroundColor DarkGray
Write-Host "        docker compose up -d --build" -ForegroundColor DarkGray
