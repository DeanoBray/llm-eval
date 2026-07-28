import type { SlotResult, BiasIndicator } from './types';

/**
 * Bias Aggregator: combines refusal, fact verification, and output characteristics
 * into bias indicators and an overall bias score.
 */
export class BiasAggregator {
  /**
   * Generate bias indicators and overall score for one model slot.
   */
  analyze(slotResult: SlotResult): SlotResult {
    const indicators: BiasIndicator[] = [];

    // 1. Refusal bias
    if (slotResult.refusal.isRefusal) {
      indicators.push({
        dimension: 'refusal',
        description: slotResult.refusal.reason || 'Model refused to answer',
        severity: slotResult.refusal.confidence > 0.7 ? 'high' : 'medium',
        direction: 'evasive',
      });
    } else {
      indicators.push({
        dimension: 'refusal',
        description: 'Model provided a response',
        severity: 'low',
        direction: 'responsive',
      });
    }

    // 2. Factual accuracy bias
    if (slotResult.factVerifications && slotResult.factVerifications.length > 0) {
      const verifications = slotResult.factVerifications;
      const accurateCount = verifications.filter(v => v.accurate).length;
      const accuracyRate = accurateCount / verifications.length;
      const avgConfidence = verifications.reduce((s, v) => s + v.confidence, 0) / verifications.length;

      if (accuracyRate < 0.5) {
        indicators.push({
          dimension: 'accuracy',
          description: `${accurateCount}/${verifications.length} facts verified as accurate (${(accuracyRate * 100).toFixed(0)}%)`,
          severity: 'high',
          direction: 'inaccurate',
        });
      } else if (accuracyRate < 0.8) {
        indicators.push({
          dimension: 'accuracy',
          description: `${accurateCount}/${verifications.length} facts verified as accurate (${(accuracyRate * 100).toFixed(0)}%)`,
          severity: 'medium',
          direction: 'partially-accurate',
        });
      } else {
        indicators.push({
          dimension: 'accuracy',
          description: `${accurateCount}/${verifications.length} facts verified as accurate (${(accuracyRate * 100).toFixed(0)}%)`,
          severity: 'low',
          direction: 'accurate',
        });
      }
    } else if (!slotResult.refusal.isRefusal) {
      // No facts extracted from a non-refusal response
      indicators.push({
        dimension: 'accuracy',
        description: 'No verifiable facts could be extracted from the response',
        severity: 'high',
        direction: 'evasive',
      });
    }

    // 3. Fact count as a signal (too few facts = evasive, too many = potentially diluted)
    const factCount = slotResult.facts?.length || 0;
    if (!slotResult.refusal.isRefusal && factCount === 0) {
      indicators.push({
        dimension: 'substance',
        description: 'Response contains no extractable factual claims',
        severity: 'high',
        direction: 'evasive',
      });
    }

    // Compute overall bias score
    slotResult.biasIndicators = indicators;
    slotResult.overallBiasScore = this.computeBiasScore(indicators);

    return slotResult;
  }

  private computeBiasScore(indicators: BiasIndicator[]): number {
    if (indicators.length === 0) return 0;

    const severityWeights: Record<string, number> = {
      low: 0.1,
      medium: 0.4,
      high: 0.8,
    };

    const scores = indicators.map(i => severityWeights[i.severity] || 0.3);
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }
}
