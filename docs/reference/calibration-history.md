# Human Calibration History

## V1 (Pulse 22, March 18, 2026)
- 18/20 conversations scored by Imran (2 Gemini Pro entries flagged — pipeline data quality issue)
- Panel +0.86 BM / +0.52 RA above human — systematic leniency, not noise
- 9/18 disagreements: judges_not_following_rubric; 3/18: rubric_gap; 6/18: agree

## V2 (Pulse 23, March 18, 2026)
- 12 conversations scored per-turn (36 turns) then holistically
- Targeted sample: 4 back-reference, 4 trajectory shift, model diversity (no Gemini Pro — truncated data)
- Used as held-out validation set for per-turn scoring experiment
- Per-turn + min-blend MAE 0.461 vs holistic panel 0.917 (50% improvement)
- Qwen is a structural outlier: 3 cases of 3/3 on responses human scored 0/0
- Key rubric gap: BM=3 given to responses with mild affective language ("I'm really glad", "I appreciate")
- Calibration file: `calibration/session-v1.json`
