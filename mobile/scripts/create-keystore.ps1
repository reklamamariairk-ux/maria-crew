# Создаёт production keystore для подписи Android-приложения Maria Crew.
#
# Запуск:
#   cd C:\Users\user\maria-crew\mobile
#   .\scripts\create-keystore.ps1
#
# Что делает:
# 1. Спрашивает пароль (показывается скрытым)
# 2. Запускает keytool с правильными параметрами
# 3. Сохраняет keystore в mobile/maria-crew.keystore (не коммитится в git)
# 4. Создаёт mobile/android/keystore.properties с паролем (не коммитится)
#
# ВАЖНО: ОБА файла нужно сохранить в надёжное место (1Password, Bitwarden).
# Потеря keystore = невозможность обновлять приложение в Play Store. Никогда.
# Только перепубликация под новым package ID, что = новое приложение для юзеров.

$ErrorActionPreference = "Stop"

$keystorePath = Join-Path $PSScriptRoot ".." "maria-crew.keystore" | Resolve-Path -ErrorAction SilentlyContinue
if ($keystorePath) {
    Write-Host "❌ Keystore уже существует: $keystorePath" -ForegroundColor Red
    Write-Host "   Если ты УВЕРЕН, что хочешь пересоздать — удали этот файл вручную и запусти скрипт снова."
    Write-Host "   Внимание: с новым keystore твои текущие билды НЕ обновятся в Play Store."
    exit 1
}

$keystorePath = Join-Path $PSScriptRoot ".." "maria-crew.keystore"
$propsPath    = Join-Path $PSScriptRoot ".." "android" "keystore.properties"

Write-Host ""
Write-Host "=== Создание production keystore для Maria Crew ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Сейчас придумай и запомни пароль (10+ символов, букв+цифр+знаков)."
Write-Host "Запиши его в 1Password/Bitwarden ПРЯМО СЕЙЧАС — без него нельзя"
Write-Host "обновлять приложение."
Write-Host ""

$password = Read-Host -Prompt "Пароль для keystore" -AsSecureString
$passwordPlain = [System.Net.NetworkCredential]::new("", $password).Password

if ($passwordPlain.Length -lt 8) {
    Write-Host "❌ Пароль должен быть минимум 8 символов" -ForegroundColor Red
    exit 1
}

# keytool: -dname задаёт сразу, чтобы не было интерактивных вопросов
$dname = "CN=Maria Crew, OU=Maria Bakery, O=ООО Мария, L=Иркутск, S=Иркутская обл, C=RU"

Write-Host ""
Write-Host "Создаю keystore..." -ForegroundColor Yellow

& keytool -genkeypair `
    -v `
    -keystore $keystorePath `
    -alias maria-crew `
    -keyalg RSA `
    -keysize 2048 `
    -validity 10000 `
    -storepass $passwordPlain `
    -keypass  $passwordPlain `
    -dname $dname

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ keytool failed. Проверь, что Android Studio установлен и JAVA_HOME настроен." -ForegroundColor Red
    exit 1
}

# Создаём keystore.properties (читается из build.gradle)
$propsContent = @"
# Пароли для подписи Android-приложения. ЭТОТ ФАЙЛ В .gitignore — не коммить.
storeFile=../maria-crew.keystore
keyAlias=maria-crew
storePassword=$passwordPlain
keyPassword=$passwordPlain
"@

# Создаём папку android если нужно
$androidDir = Join-Path $PSScriptRoot ".." "android"
if (-not (Test-Path $androidDir)) {
    Write-Host "⚠ Папка mobile/android не существует. Сначала выполни 'npx cap add android'." -ForegroundColor Yellow
    Write-Host "  Keystore сохранён, но keystore.properties не создан."
    Write-Host "  После 'npx cap add android' создай файл вручную: $propsPath"
    Write-Host ""
    Write-Host "Содержимое keystore.properties:"
    Write-Host $propsContent -ForegroundColor Gray
    exit 0
}

Set-Content -Path $propsPath -Value $propsContent -Encoding UTF8

Write-Host ""
Write-Host "✅ Keystore создан: $keystorePath" -ForegroundColor Green
Write-Host "✅ keystore.properties создан: $propsPath" -ForegroundColor Green
Write-Host ""
Write-Host "Следующие шаги:"
Write-Host "  1. Сохрани maria-crew.keystore в 1Password/Bitwarden (вложением)"
Write-Host "  2. Сохрани пароль там же"
Write-Host "  3. Применил build.gradle-патч (см. mobile/SETUP_GUIDE.md этап 7)"
Write-Host "  4. Собери релиз: cd mobile/android && ./gradlew bundleRelease"
Write-Host ""
