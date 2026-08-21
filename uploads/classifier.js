import { lookupName, applySuffixRules, applyCharNgram, analyzeUsername, loadNameDb } from './classifier_names.js';
import { detectPronouns, analyzeBioKeywords } from './classifier_bio.js';

// Load name DB once at module initialization
loadNameDb().catch(e => console.warn('[classifier] Failed to load name DB', e));

export function computeFemaleLikelihood(raw, enriched, faceResult, settings) {
    let totalScore = 0;
    let totalWeight = 0;
    const signals = {};

    // Signal 1: Name Lookup, Suffixes, or N-grams
    const fullName = raw?.full_name || raw?.fullName || '';
    if (fullName) {
        const firstName = fullName.split(/\s+/)[0];
        let nameScore = lookupName(firstName);
        
        if (nameScore !== null) {
            totalScore += nameScore * 35;
            totalWeight += 35;
            signals.name = { source: 'name', value: fullName, weight: 35, rawScore: nameScore };
        } else {
            nameScore = applySuffixRules(fullName);
            if (nameScore !== null) {
                totalScore += nameScore * 25;
                totalWeight += 25;
                signals.name = { source: 'name_ngram', value: fullName, weight: 25, rawScore: nameScore };
            } else {
                nameScore = applyCharNgram(fullName);
                if (nameScore !== null) {
                    totalScore += nameScore * 15;
                    totalWeight += 15;
                    signals.name = { source: 'name_ngram', value: fullName, weight: 15, rawScore: nameScore };
                }
            }
        }
    }

    // Signal 2: Username Analysis
    if (raw && raw.username) {
        const userScore = analyzeUsername(raw.username);
        if (userScore !== null) {
            totalScore += userScore * 10;
            totalWeight += 10;
            signals.username = { score: userScore };
        }
    }

    // Signal 3: Bio Pronouns and Keywords
    if (enriched && enriched.biography) {
        const pronounResult = detectPronouns(enriched.biography);
        if (pronounResult) {
            totalScore += pronounResult.score * 25;
            totalWeight += 25;
            signals.pronouns = pronounResult;
        }

        const kwResult = analyzeBioKeywords(enriched.biography);
        if (kwResult.hasSignals) {
            totalScore += kwResult.score * 15;
            totalWeight += 15;
            signals.bioKeywords = kwResult;
        }
    }

    // Signal 4: Face Classifier Result
    if (faceResult && settings && settings.enableFaceClassifier) {
        totalScore += faceResult.score * 20;
        totalWeight += 20;
        signals.face = faceResult;
    }

    // Calculate weighted average
    const finalScore = totalWeight > 0 ? (totalScore / totalWeight) : 50;

    // Determine Confidence
    let confidence = 'low';
    if (totalWeight >= 50) confidence = 'high';
    else if (totalWeight >= 25) confidence = 'medium';

    // Determine Label
    let label = 'reject';
    if (finalScore >= 85) label = 'high_priority';
    else if (finalScore >= 70) label = 'qualified';
    else if (finalScore >= 50) label = 'review';

    return {
        femaleScore: Math.round(finalScore),
        label,
        signals,
        confidence
    };
}

export function classifyTier1(raw) {
    return computeFemaleLikelihood(raw, null, null, { enableFaceClassifier: false });
}

export function classifyTier2(raw, enriched, faceResult, settings) {
    return computeFemaleLikelihood(raw, enriched, faceResult, settings);
}
