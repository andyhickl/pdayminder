# PDayMinder: Annotated Bibliography

_What each test, score and reference range in the app rests on, and how far to trust it. Updated October 31, 2026._

## Composite scoring and clinical scales

**Zhan A, Mohan S, Tarolli C, et al. Using smartphones and machine learning to quantify Parkinson disease severity: the mobile Parkinson disease score (mPDS). JAMA Neurology 2018;75(7):876–880.** [https://pmc.ncbi.nlm.nih.gov/articles/PMC5885192](https://pmc.ncbi.nlm.nih.gov/articles/PMC5885192)
Built a 0–100 severity score from 435 smartphone features (gait, balance, finger tapping, voice, reaction time) using rank learning on pre-dose vs post-dose pairs; r = 0.88 with MDS-UPDRS III in 16 paired visits. Relative weights: gait 33.4 %, balance 23.2 %, tapping 23.0 %, voice 17.0 %, reaction time 3.4 %. _Used for:_ the weights of the Motor and Voice composites (renormalised over our tasks, tremor added at its UPDRS share), and the idea of learning personal weights from pre/post-dose pairs (backlog).

**Goetz CG, Tilley BC, Shaftman SR, et al. Movement Disorder Society-sponsored revision of the Unified Parkinson's Disease Rating Scale (MDS-UPDRS). Movement Disorders 2008;23(15):2129–2170.**
The clinical standard. Part III (motor) is an unweighted sum of 33 items scored 0–4. Item 3.17 rates rest tremor amplitude by excursion (0 none, 1 under 1 cm, 2 1–3 cm, 3 3–10 cm, 4 over 10 cm); item 3.4 rates finger tapping by rate, rhythm, hesitations and decrement. _Used for:_ the tremor amplitude bins, the tapping heuristic, the 0–4 direction behind our 1–5 scores, and tremor's share in the motor composite.

**Bot BM, Suver C, Neto EC, et al. The mPower study, Parkinson disease mobile data collected using ResearchKit. Scientific Data 2016;3:160011.**
The iPhone study whose tasks (tapping, voice, gait, balance, memory) our tests mirror; tens of thousands of participants. _Used for:_ task design and the pocket/hand protocols. Its voice recordings are a candidate validation corpus (needs a data-use agreement).

## Tremor

**Powers R, Etezadi-Amoli M, Arnold EM, et al. Smartwatch inertial sensors continuously monitor real-world motor fluctuations in Parkinson's disease. Science Translational Medicine 2021;13(579):eabd7865.**
The Apple Movement Disorder API paper: wrist accelerometry classifies resting tremor and dyskinesia per minute. _Relevance:_ this is what StrivePD and Parky read; the data never reaches HealthKit, which is why our tremor test exists. A native app with Apple's entitlement would give passive access (backlog).

**Physics of the amplitude estimate.** For a sinusoid, displacement = acceleration / (2πf)². The tremor test converts band-limited (3.5–7.5 Hz) acceleration at the band peak into peak-to-peak hand excursion in cm and bins it on MDS-UPDRS 3.17. Validated on synthetic signals within a few percent; it estimates the clinical score rather than replacing a rating by eye.

## Finger tapping

**MDS-UPDRS item 3.4** (above) and the mPower tapping task. Our rate bands (4, 3, 2, 1 taps/s), rhythm CV, first-half vs second-half slowdown and hesitation count are a heuristic in the spirit of the item, not calibrated to clinic ratings. The personal baseline is the reference that matters.

## Gait

**Moe-Nilssen R, Helbostad JL. Estimation of gait cycle characteristics by trunk accelerometry. Journal of Biomechanics 2004;37(1):121–126.**
Autocorrelation of trunk acceleration at one-step and two-step lags gives step and stride regularity; their difference indexes asymmetry. _Used for:_ `gait_step_regularity`, `gait_stride_regularity`, `gait_asymmetry`.

**Healthy cadence and variability.** Preferred-speed walking in healthy adults runs about 110–120 steps/min with step-time variability of 2–3 %; PD raises variability and asymmetry before cadence falls. Our norms (112 ± 9 /min, 2.5 ± 1.5 %) summarise this literature and assume straight-line walking; indoor walks with turns read worse for everyone.

## Balance

**Mancini M, Salarian A, Carlson-Kuhta P, et al. ISway: a sensitive, valid and reliable measure of postural control. Journal of NeuroEngineering and Rehabilitation 2012;9:59.**
Lumbar accelerometer during 30 s quiet stance; jerk and sway amplitude distinguish early PD from controls and have good test–retest reliability. _Used for:_ the balance metrics (sway RMS, jerk, path, ellipse area, frequency) and the approximate eyes-open norms. Our sensor is a phone held against the chest, not a lumbar unit, so the norm score is labelled approximate.

## Voice: sustained vowel

**Little MA, McSharry PE, Hunter EJ, Spielman J, Ramig LO. Suitability of dysphonia measurements for telemonitoring of Parkinson's disease. IEEE Transactions on Biomedical Engineering 2009;56(4):1015–1022.**
Introduced pitch period entropy (PPE) and the UCI "Parkinsons" dataset (195 sustained-vowel recordings, 8 healthy and 24 PD subjects, Praat-style features). _Used for:_ PPE, and the healthy reference percentiles for jitter, shimmer, HNR and PPE (studio microphone; phone recordings read noisier).

**Tsanas A, Little MA, McSharry PE, Ramig LO. Accurate telemonitoring of Parkinson's disease progression by noninvasive speech tests. IEEE Transactions on Biomedical Engineering 2010;57(4):884–893.**
The UCI telemonitoring set: 42 PD patients, 5,875 recordings over six months with UPDRS. _Our re-analysis:_ classic jitter, shimmer and HNR show roughly zero within-person correlation with motor UPDRS over time, which is why the sustained vowel is treated as a slow baseline rather than a dose tracker.

**Boersma P, Weenink D. Praat: doing phonetics by computer; Jadoul Y, Thompson B, de Boer B. Introducing Parselmouth. Journal of Phonetics 2018;71:1–15.**
Reference implementation for jitter, shimmer and HNR. _Validation:_ our analyser matches Praat on synthetic phonations for F0 (exact), jitter (within ~0.02 points), HNR (within ~1 dB with noise present); shimmer reads about a third lower on step-change test tones.

**Maslan J, Leng X, Rees C, Blalock D, Butler SG. Maximum phonation time in healthy older adults. Journal of Voice 2011;25(6):709–713.**
Normative hold times for sustained /a/ in healthy adults; most land between about 15 and 25 s, with men slightly longer and a slow decline with age. _Used for:_ the 20 ± 6 s reference behind `voice_mpt_norm`. Reduced phonation time in PD reflects weaker breath support and incomplete vocal-fold closure and improves with LSVT-style voice therapy, which is why it sits outside the Voice composite as a slow, therapy-sensitive measure.

## Voice: pa-ta-ka, reading, levodopa response

**Rusz J, Cmejla R, Ruzickova H, Ruzicka E. Quantitative acoustic measurements for characterization of speech and voice disorders in early untreated Parkinson's disease. Journal of the Acoustical Society of America 2011;129(1):350–367.** [https://www.sami.fel.cvut.cz/Articles/Rusz_et_al_FA2011.pdf](https://www.sami.fel.cvut.cz/Articles/Rusz_et_al_FA2011.pdf)
23 early untreated PD vs 23 controls. Healthy references we use: /pa-ta-ka/ 7.16 ± 0.73 syllables/s (PD 6.22), reading F0 SD 2.48 ± 0.56 semitones (PD 1.71), sustained-vowel jitter 0.32 ± 0.32 %, HNR 24.0 ± 5.6 dB. Czech speakers, mean age 58, lab recordings.

**de Jong NH, Wempe T. Praat script to detect syllable nuclei and measure speech rate automatically. Behavior Research Methods 2009;41(2):385–390.**
Syllables as intensity peaks with a dip between them. _Used for:_ the pa-ta-ka syllable counter and the reading-rate estimate; no speech recognition is involved.

**Digital speech biomarkers can measure acute effects of levodopa in Parkinson's disease. npj Parkinson's Disease 2025 (Bern).** [https://www.nature.com/articles/s41531-025-01045-5](https://www.nature.com/articles/s41531-025-01045-5)
51 fluctuating patients recorded OFF and 30–60 min after levodopa. Within-subject improvements: intensity slope during sustained phonation (effect size 0.49) and pitch SD in read speech (0.47). _Used for:_ the loudness-slope metric, the reading test, and the weighting that puts pa-ta-ka and reading ahead of the vowel.

**Automatic speech analysis combined with machine learning reliably predicts the motor state in people with Parkinson's disease. npj Parkinson's Disease 2025 (Cologne).** [https://pmc.ncbi.nlm.nih.gov/articles/PMC12048546/](https://pmc.ncbi.nlm.nih.gov/articles/PMC12048546/)
78 responders, OFF then ON. DDK irregularity, voice onset time and power variability improved ON; jitter 0.58→0.50 % and shimmer 3.46→3.06 %; multi-task classifier AUC 0.74. _Used for:_ the case that speech tracks levodopa state modestly, with DDK carrying most of it.

## Spiral

Spiral drawing is a standard clinical tremor task; digitised versions score deviation from the ideal path and tremor in the residual. Finger-on-glass is noisier than pen-on-tablet, so our deviation and tremor-share metrics are meant for within-person tracking only.

## Data sources and plumbing

**Oura API v2** (OAuth2): sleep stages, night HRV, lowest heart rate, readiness, activity, temperature deviation, SpO2. **Health Auto Export** (iOS) relays Apple Health metrics, including the Watch's gait measures (walking speed, step length, double support, asymmetry), heart rate and HRV; iOS drops its Authorization header, so the key travels in the URL. **Apple Health** has no cloud API and does not receive Movement Disorder API data.

## How to read the scores

Every test produces raw measures, a personal score (1–5, how today compares with your own prior tests, needing five of them first) and, where a mic-robust measure and a published healthy reference exist, a norm score (1–5 against healthy controls). Personal scores answer "am I like my usual self?"; norm scores answer "how does my usual self compare with healthy adults?". Both can be true at once. None of this is a diagnosis, and nothing here should change a medication schedule without a clinician.
