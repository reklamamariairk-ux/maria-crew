// ════════════════════════════════════════════════════════════════════════════
// Signing config для production-сборки Maria Crew.
//
// КУДА ВСТАВИТЬ: mobile/android/app/build.gradle
//   1. Скопируй блок `def keystorePropertiesFile` ВЫШЕ строки `android {`
//   2. Скопируй блоки `signingConfigs` и поправку `buildTypes.release`
//      ВНУТРЬ блока `android { ... }`
//
// ПОСЛЕ ВСТАВКИ удалить старый `buildTypes { release { ... } }` —
// чтобы не было дублирования.
//
// Файл `keystore.properties` создаётся скриптом scripts/create-keystore.ps1.
// ════════════════════════════════════════════════════════════════════════════


// ── ВЫШЕ android { ─────────────────────────────────────────────────────────
def keystorePropertiesFile = rootProject.file("keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}


// ── ВНУТРИ android { ─ заменяет существующий buildTypes блок ──────────────
    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                storeFile     file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias      keystoreProperties['keyAlias']
                keyPassword   keystoreProperties['keyPassword']
            }
        }
    }

    buildTypes {
        release {
            // Подписываем только если keystore.properties есть.
            // Без него gradle bundleRelease упадёт, но debug-сборки ещё работают.
            if (keystorePropertiesFile.exists()) {
                signingConfig signingConfigs.release
            }
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
