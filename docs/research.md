# Why I'm tracking my Parkinson's

I'm Andy Hickl. I have early-onset Parkinson's disease. I also happen to be the CTO of the Allen Institute, which means I spend my working life around people who measure things carefully and change their minds when the data says so. PDayMinder is my attempt to do that for my own disease.

## The problem

Parkinson's is managed on very little data. I see my neurologist a few times a year. In between, the only record of how I'm doing is my memory, and memory is a poor instrument for a condition that changes hour to hour with each dose of levodopa. When my doctor asks "how have the afternoons been?", the honest answer is that I don't know.

Meanwhile I already wear a watch and a ring that measure my sleep, heart rate, steps and gait every day. My phone can measure a tremor, time my finger taps and analyze my voice. None of that reaches my care, because it lives in separate apps that don't talk to each other or to me.

## What PDayMinder does

PDayMinder is a small web app I built for myself (and open-sourced). It does four things:

1. Asks me, every two hours, how I'm doing on a 1–5 scale. That is the ground truth everything else is compared against.
2. Pulls in what my devices already measure: sleep stages and night HRV from Oura, heart rate, steps and Apple Watch gait metrics (walking speed, double support, asymmetry) from Apple Health, and logs each medication dose with its time.
3. Runs short, repeatable tests on my phone: a 20-second resting tremor recording, finger tapping, a two-minute walk (free and to a metronome), a balance stand, a spiral trace, a sustained "ahh", a pa-ta-ka repetition and a short reading passage. Each one produces measures that the movement-disorder literature has already validated, and each one is scored two ways: against healthy reference values, and against my own history.
4. Puts it all on one timeline, so I can ask simple questions. Does a bad night predict a bad afternoon? Does my tremor change in the hour after a dose? Is my voice drifting over months even when I feel fine?

<!-- shots: qol tests trends stats correlations -->

Screenshots use synthetic demo data, not my own.

## The rationale: measurement in service of outcomes

I'm not trying to diagnose anything; I already have the diagnosis. I'm trying to make better decisions with my neurologist about things that are adjustable: when I take levodopa, how much, how I exercise, how I sleep and whether a change actually did anything. Those decisions are made today on anecdote. A consistent record of symptoms, function and context turns them into something closer to an experiment, with me as the only subject.

The specific hopes are modest and concrete:

- Find my own dose-response pattern: how long a dose takes to work for me, how long it lasts and what "wearing off" looks like in the data before I notice it.
- Catch slow drift early. Voice and gait measures move over months, not days. A personal baseline makes a half-standard-deviation change visible.
- Give my care team something better than "the afternoons have been okay": a short status report built from the same numbers every time.
- Test the things I'm told help (exercise, sleep, timing meals around doses) against my own data instead of taking them on faith.

If this is useful for me, it might be useful for others. The code is public and the methods are documented, with the papers each measure comes from.

## Why I'm asking Apple for the Movement Disorder API

Apple Watch already runs a validated tremor and dyskinesia classifier in the background (the same one behind apps like StrivePD). Its results don't flow into Apple Health, so I can't get at them without building a native app that holds Apple's Movement Disorder API entitlement. I've asked for that entitlement. The request, and the data-handling commitments that come with it, are written up at [/apple-movement-disorder](/apple-movement-disorder). Passive, all-day tremor data is the single biggest gap in what I can measure today: my phone tests take 20 seconds a few times a day; the watch is on my wrist for 16 hours.

## What I'm careful about

- This is my own data about my own disease, collected with my consent, stored in a database I control, behind a login. Nobody else's data is involved unless they choose to run the software themselves.
- None of the scores are diagnostic. The app deliberately avoids "you look Parkinsonian" language, because a single reading from a phone microphone can't carry that weight. It compares me to me.
- Every measure cites the paper it comes from. Where my implementation falls short of the reference (for example, phone microphones are noisier than the studio recordings behind the voice norms), that's written down too.
- Medical decisions stay with my neurologist. The app's job is to make the conversation better informed.

## Links

- [The app](/) (login required) and [source code](https://github.com/andyhickl/pdayminder)
- [Annotated bibliography](/bibliography): every measure and the literature behind it
- [Apple Movement Disorder API request](/apple-movement-disorder)
- [Privacy policy](/privacy) and [terms of service](/terms)

Questions or interest in the project: andy.hickl@gmail.com.
