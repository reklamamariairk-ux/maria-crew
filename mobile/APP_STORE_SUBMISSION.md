# App Store submission — Maria Crew

## App record

- Bundle ID: `ru.mariairk.crew`
- Name: `Maria Crew`
- Primary category: Business
- Distribution: Unlisted App
- Privacy Policy URL: `https://crew.145-223-121-47.sslip.io/privacy`
- Support URL: `https://crew.145-223-121-47.sslip.io/support`
- Price: Free
- In-App Purchases: No
- Tracking: No

## App Privacy answers

Declare these data types as linked to the user and not used for tracking:

- Contact Info → Name, Email Address, Phone Number — App Functionality
- Identifiers → User ID — App Functionality
- User Content → Photos or Videos, Other User Content — App Functionality
- Usage Data → Product Interaction — App Functionality and Analytics
- Purchases → Purchase History — App Functionality when Maria Store exchanges are treated as purchase history

Do not declare advertising, precise location, contacts, health, payment information, device advertising ID, or tracking unless the implementation changes. Include push tokens under identifiers/device ID if the final App Store Connect questionnaire classifies the generated token as a device identifier.

## Review Notes

`Maria Crew` is an internal employee resource for the Maria confectionery organization in Irkutsk. Access is limited to existing employees. This business app therefore uses the organization's existing employee account and one-time PIN flow. It does not use consumer social login for the primary iOS account. The app contains no paid digital content and no in-app purchases. Employees use it for internal challenges, quizzes, recognition, notifications and reward requests. Account deletion is available inside the app and removes direct identifiers, authentication PINs and push tokens.

Submit an Unlisted App request and provide a stable reviewer account plus a PIN delivery method controlled by the reviewer. The account must contain realistic sample data and access to every feature. Do not provide real employee data in screenshots or reviewer credentials.

## Final Mac checklist

The repository contains `.github/workflows/ios-testflight.yml`, so the archive can be built on GitHub's macOS runner without owning a Mac. Configure these repository secrets before running it:

- `APPLE_TEAM_ID`
- `IOS_DISTRIBUTION_CERTIFICATE_BASE64`
- `IOS_CERTIFICATE_PASSWORD`
- `IOS_PROVISIONING_PROFILE_BASE64` for `ru.mariairk.crew` (including Push Notifications entitlement if notifications remain enabled)
- `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, and `APP_STORE_CONNECT_API_PRIVATE_KEY_BASE64` when TestFlight upload is enabled

Run **Actions → iOS — Maria Crew → Run workflow**. Leave TestFlight upload disabled for the first signing check; enable it after the signed IPA is produced successfully.

1. Copy the production `GoogleService-Info.plist` from `ios-config/` into the Xcode App target only if Firebase Messaging is retained; never publish credentials in documentation.
2. `npm ci && npx cap sync ios && cd ios/App && pod install`
3. Open `App.xcworkspace`, select the Apple Developer team, and enable Automatically manage signing.
4. Add the Push Notifications capability and verify `aps-environment` in the signed archive.
5. Confirm that the iOS push token is sent by a compatible APNs/FCM provider; otherwise disable the permission prompt for the first release.
6. Generate an Xcode Privacy Report and reconcile it with `PrivacyInfo.xcprivacy` and App Privacy answers.
7. Test login, PIN delivery, Privacy, account deletion and denied notification permission on a physical iPhone.
8. Archive, Validate App, upload to App Store Connect and test through TestFlight.
9. Submit the build to review with Unlisted distribution noted, then file the Unlisted App request.
