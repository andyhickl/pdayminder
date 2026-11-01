# Apple Movement Disorder API: request and commitments

This page documents my request to Apple for the Movement Disorder API entitlement (`com.apple.developer.health-movement-disorder`), what the API is, why I need it, and how the resulting app will handle data. Background on the project is at [/research](/research).

## What the API is

Apple Watch (watchOS 5 and later) runs an on-device classifier, `CMMovementDisorderManager` in Core Motion, that estimates Parkinsonian resting tremor (3–7 Hz) and choreiform dyskinesia from the wrist, all day, in the background. Results are written to the watch, not to Apple Health, and can only be read by an app that holds an entitlement Apple grants on request. Apple's documentation: [CMMovementDisorderManager](https://developer.apple.com/documentation/coremotion/cmmovementdisordermanager) and [Adhering to the movement disorder data collection requirements](https://developer.apple.com/documentation/coremotion/adhering-to-the-movement-disorder-data-collection-requirements).

Apple's stated conditions: collect only from people clinically diagnosed with a movement disorder, keep all medical decisions with a licensed clinician, show a data-use introduction screen with specific disclosures, and follow HealthKit's privacy guidelines. The entitlement comes with a Movement Disorder API Addendum that only Apple Developer Program account holders can read.

## Why I need it

I have a clinical diagnosis of early-onset Parkinson's disease. I wear an Apple Watch on my most affected arm roughly 16 hours a day. The tremor classifier is already running; its output is the one measurement in my toolkit that is passive, continuous and validated (Powers et al., Science Translational Medicine 2021, in the [bibliography](/bibliography)). Everything else I collect is either a 20-second active test a few times a day or a wearable metric that is only indirectly about Parkinson's. Continuous tremor and dyskinesia percentages, lined up against dose times and my own two-hourly quality-of-life ratings, would let me and my neurologist see my actual levodopa response rather than guess at it.

## The request: step by step

1. Hold an Apple Developer Program membership (individual, US$99/year). The request form is behind that login.
2. Register an App ID (bundle identifier) for the iOS app and its watchOS companion, for example `com.andyhickl.pdayminder` and `com.andyhickl.pdayminder.watchkitapp`.
3. Submit the form at [developer.apple.com/contact/request/movement-disorder-api-entitlement](https://developer.apple.com/contact/request/movement-disorder-api-entitlement/). It asks for the app, the team, a description of the app and its users, and how the movement disorder data will be used and protected. Draft answers are below.
4. Accept the Movement Disorder API Addendum when Apple sends it (Account Holder only).
5. After approval, enable the entitlement on the App ID, regenerate provisioning profiles, and add `com.apple.developer.health-movement-disorder` to the watch extension's `.entitlements` file. Add `NSMotionUsageDescription` to `Info.plist` (the app crashes without it).
6. Build the introduction screen with the required disclosures (verbatim text below), the self-report confirmation of diagnosis, and an opt-out.
7. Call `monitorKinesias(forDuration:)` to keep the classifier recording, and `queryTremor` / `queryDyskineticSymptom` on a schedule to copy results into PDayMinder, since the watch keeps results only for a limited window.
8. Ship through TestFlight for personal use first; App Store distribution is not the goal.

Reports from other developers suggest Apple replies within days to a few weeks, and that individual developers with a clear health-data story are approved; the common stumbling block is the entitlement not appearing in Xcode's Capabilities list, which is solved by adding the key to the entitlements file by hand.

## Draft answers for the form

**App name and purpose.** PDayMinder, a personal Parkinson's tracking app. It records quality-of-life ratings, medication doses, phone-based motor and voice tests, and wearable data, and shows them on one timeline so the user and their neurologist can see symptom patterns over the day and over months. The app is open source (github.com/andyhickl/pdayminder).

**Target users.** Adults with a clinical diagnosis of Parkinson's disease, starting with the developer. The app asks the user to confirm a clinical diagnosis of resting tremor before any movement disorder monitoring starts, and does nothing with the API otherwise.

**How movement disorder data is used.** Tremor and dyskinesia results are copied from the watch to the user's own PDayMinder account (a Postgres database behind a login, hosted by the user or by me for myself) and displayed alongside dose times and self-ratings. The purpose is to inform conversations with the user's clinician about medication timing and symptom patterns. The app makes no diagnosis, no treatment recommendation and no automated medical decision.

**Background collection.** Yes. The watch classifier runs in the background; the app calls `monitorKinesias` and periodically reads results. The introduction screen discloses this with Apple's required wording.

**Data protection.** Data is transmitted over TLS to a server the user controls or has an account on; stored per user; never sold, shared with third parties or used for advertising; exportable and deletable by the user at any time. Full [privacy policy](/privacy) and [terms](/terms). The app will follow HealthKit's privacy guidance for health data handling.

**Opt out.** A single switch in Settings stops monitoring, and the user can delete all stored movement disorder data from the app.

## Required introduction screen text

Apple requires these sentences verbatim on the first-launch screen, in addition to the app's purpose, audience, data collected, data use, background collection statement and opt-out instructions:

> This app is monitoring and collecting your Parkinsonian resting tremor data, only if you self-report or have been clinically diagnosed with resting tremor, and indicate within the app that this is true.

> This app is monitoring and collecting your choreiform dyskinesia data, only if you self-report or have been clinically diagnosed with choreiform dyskinesias, and indicate within the app that this is true.

> This app is able to collect your movement disorder data even when the app is not active, on screen, or responding to your user input.

## What gets built

A minimal iOS app plus watchOS companion, Swift, no third-party SDKs:

- Watch: start/renew `monitorKinesias(forDuration:)`; on a schedule, query tremor and dyskinesia results since the last sync and hand them to the phone.
- Phone: introduction and consent screen, diagnosis confirmation, PDayMinder API key entry, background upload of results to `/api/observations` as `source = watch` metrics (`tremor_pct_slight`, `tremor_pct_mild`, `tremor_pct_moderate`, `tremor_pct_strong`, `tremor_pct_none`, `tremor_pct_unknown`, `dyskinesia_pct_likely`, `dyskinesia_pct_unlikely`) at the API's native resolution.
- PDayMinder: day view bands for tremor and dyskinesia over the QoL ratings and dose lines; daily rollups in Trends and Stats; the same personal-baseline scoring used elsewhere.

## Links

- [Why I'm tracking my Parkinson's](/research)
- [Annotated bibliography](/bibliography)
- [Privacy policy](/privacy) · [Terms of service](/terms)
- [Source code](https://github.com/andyhickl/pdayminder)

Contact: andy.hickl@gmail.com
