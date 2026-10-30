# PDayMinder Privacy Policy

_Last updated: October 30, 2026_

PDayMinder is a personal health-tracking application built and operated by Andy Hickl for his own use in managing early-onset Parkinson's disease. It is not a commercial product and is not offered to the public. This policy describes how data is handled so that connected services (such as Oura) and anyone reviewing the application can see exactly what it does.

## Who uses it

A single user: the operator. Accounts are created by the operator, not by self-signup. There are no other users, customers, or subscribers.

## What data is collected

- **Entries you make in the app**: quality-of-life ratings in two-hour blocks, medication dose times, and settings such as sleep window and reminder times.
- **Data from connected devices and services**, only after you connect them: heart rate, heart rate variability, sleep stages and scores, readiness and activity scores, steps, walking and gait metrics, workouts, temperature deviation, SpO2, and similar measurements. Current sources are Apple Health (via the Health Auto Export app) and Oura (via Oura's API under OAuth2 authorization). Other sources such as Whoop, Strava, TrainingPeaks, or Concept2 may be added in the same way.
- **Technical records**: login sessions, API keys you create, OAuth tokens for connected services, and a log of sync requests (timestamps, row counts, and the shape of the payload, not the health values themselves).

## How data is used

To display your own history and trends back to you, and to generate personal reports and recommendations for you. Data is not used for advertising, profiling of anyone else, training models for third parties, or any purpose unrelated to your own care.

## Where data is stored

In a PostgreSQL database hosted on Render (render.com) in the United States, accessible only to the application. The application itself runs on Render. Transport is encrypted (HTTPS). Passwords are stored as bcrypt hashes; API keys are stored as SHA-256 hashes; OAuth tokens are stored so the sync job can refresh them.

## Sharing

Data is not sold, rented, or shared with third parties. The only parties that process it are the hosting provider (Render) as a data processor, and the source services you connect, which only ever send data to the application, never receive it. You may choose to share reports with your own clinicians; that is your action, not the application's.

## Oura data

Oura data is accessed only with your explicit OAuth2 authorization and only for the scopes you approve. It is used solely to show your own sleep, readiness, and activity alongside your other data. You can revoke access at any time from Settings → Integrations in the app, or from your Oura account, after which the application can no longer retrieve new Oura data. Use of Oura data complies with the Oura API Terms of Use.

## Retention and deletion

Data is kept for as long as the operator finds it useful for tracking the condition over time. Because the operator is the only user, deletion means deleting the database, which the operator can do at any time from the hosting dashboard. Anyone who believes their data has ended up in this application in error can write to the contact below and it will be removed.

## Security

Everything is behind a password login or per-integration API keys that can be revoked individually. There is no public data endpoint. The source code is open at github.com/andyhickl/pdayminder so the handling described here can be verified.

## Children

The application is not directed at, and does not knowingly collect data from, anyone under 18.

## Changes

If the application ever becomes available to other people, this policy will be rewritten before that happens and the date above will change.

## Contact

Andy Hickl, andy.hickl@gmail.com
