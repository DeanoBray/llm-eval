import type { RefusalResult } from './types';

/**
 * Heuristic-based refusal detector.
 * Checks for common refusal patterns across English and Chinese.
 * Can be extended with ML-based classification.
 */
export class RefusalDetector {
  // English refusal patterns
  private enRefusalPatterns = [
    /I cannot (answer|provide|respond|comment|assist)/i,
    /I('m|\s+am) (sorry|unable|not able)/i,
    /as an AI/i,
    /I don't have enough (information|context)/i,
    /it would be (inappropriate|irresponsible)/i,
    /I (must|need to) (decline|refrain)/i,
    /against my (guidelines|policies|safety)/i,
  ];

  // Chinese refusal patterns
  private zhRefusalPatterns = [
    /我(不能|无法|没有|不会)/,
    /抱歉/,
    /作为一个AI/,
    /我没有足够/,
    /这不(合适|恰当)/,
    /我必须(拒绝|避免)/,
    /不符合.*政策/,
    /基于我的.*准则/,
    /这个话题/,
    /换个话题/,
  ];

  // Empty/short response thresholds
  private minResponseLength = 20;

  detect(response: string, language: 'en' | 'zh'): RefusalResult {
    const patterns = language === 'en'
      ? this.enRefusalPatterns
      : this.zhRefusalPatterns;

    const trimmed = response.trim();

    // Empty or very short response = likely refusal
    if (trimmed.length < this.minResponseLength) {
      return {
        isRefusal: true,
        confidence: 0.9,
        reason: 'response too short or empty',
      };
    }

    // Check against patterns
    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (match) {
        return {
          isRefusal: true,
          confidence: 0.85,
          reason: `matched pattern: "${match[0].substring(0, 50)}"`,
        };
      }
    }

    // Also check for content-warning-style refusals
    if (
      (language === 'en' && /I (understand|recognize|appreciate).*(however|but|nevertheless)/i.test(trimmed)) ||
      (language === 'zh' && /我(理解|知道|明白).*(但是|不过|然而)/.test(trimmed))
    ) {
      // Hedged response — could be partial refusal
      return {
        isRefusal: true,
        confidence: 0.5,
        reason: 'hedged or qualified response',
      };
    }

    return {
      isRefusal: false,
      confidence: 0.9,
    };
  }
}
