export interface ParsedCleaningPlan {
  actionKind:
    | 'set_negative_to'
    | 'abs_negative'
    | 'delete_negative'
    | 'cap_above'
    | 'floor_below'
    | 'delete_above'
    | 'delete_below'
    | 'nullify_negative'
    | 'nullify_above'
    | 'nullify_below'
    | 'nullify_outliers'
    | 'clamp_outliers_iqr'
    | 'delete_outliers_iqr'
    | 'replace_value'
    | 'fill_missing_value'
    | 'impute_missing'
    | 'delete_missing'
    | 'normalize_title'
    | 'normalize_upper'
    | 'normalize_lower'
    | 'trim_whitespace'
    | 'nullify_orphan_fk'
    | 'delete_orphan_fk';
  description: string;
  threshold?: number;
  replacementValue?: string | number | null;
  matchValue?: string;
}

/**
 * Deterministic parser that translates a plain/general-language cleaning instruction
 * into a structured, safe SQLite mutation plan scoped to the chosen table & column.
 * Returns null if the phrase requires LLM translation or clarification.
 */
export function parseGeneralLanguageCleaningRule(
  instruction: string
): ParsedCleaningPlan | null {
  const raw = instruction.trim();
  if (!raw) return null;
  const low = raw.toLowerCase().replace(/\s+/g, ' ');

  const isDelete = /\b(delete|remove|drop|purge)\b/.test(low) && /\brow(s)?\b|\borphan\b|\bnegative\b|\boutlier|\bmissing\b|\bnull\b|\bempty\b|\babove\b|\bover\b|\bbelow\b|\bunder\b|\bgreater\b|\bless\b/.test(low);

  // 1. Orphan foreign keys
  if (/\borphan/.test(low)) {
    if (/\b(delete|remove|drop)\b/.test(low) && !/\bnull/.test(low)) {
      return {
        actionKind: 'delete_orphan_fk',
        description: 'Delete rows with orphan foreign-key references.',
      };
    }
    return {
      actionKind: 'nullify_orphan_fk',
      description: 'Set orphan foreign-key references to NULL.',
    };
  }

  // 2. Replace explicit X with Y: replace 'a' with 'b' / change a to b
  const replaceQuoted = raw.match(
    /(?:replace|change|convert|map|set)\s+['"`]([^'"`]+)['"`]\s+(?:with|to|into|as)\s+['"`]([^'"`]*)['"`]/i
  );
  if (replaceQuoted) {
    const fromVal = replaceQuoted[1];
    const toVal = replaceQuoted[2];
    return {
      actionKind: 'replace_value',
      matchValue: fromVal,
      replacementValue: toVal,
      description: `Replace "${fromVal}" with "${toVal}".`,
    };
  }

  // 3. Negative values
  if (/\bnegative(s)?\b|<\s*0\b|\bbelow zero\b|\bless than zero\b/.test(low)) {
    if (/\b(abs|absolute|positive|flip sign)\b/.test(low)) {
      return {
        actionKind: 'abs_negative',
        description: 'Convert negative numbers to positive values (ABS).',
      };
    }
    if (/\b(delete|remove|drop)\b/.test(low) && /\brow/.test(low)) {
      return {
        actionKind: 'delete_negative',
        description: 'Delete rows containing negative values.',
      };
    }
    if (/\bnull(ify)?\b/.test(low) && !/\bimpute|guess|fill\b/.test(low)) {
      return {
        actionKind: 'nullify_negative',
        description: 'Set negative values to NULL.',
      };
    }
    const numMatch = low.match(/(?:to|with|as|=)\s*(-?\d+(?:\.\d+)?)/);
    if (numMatch) {
      const target = Number(numMatch[1]);
      return {
        actionKind: 'set_negative_to',
        replacementValue: target,
        description: `Replace negative values with ${target}.`,
      };
    }
    if (/\b(delete|remove|drop)\b/.test(low)) {
      return {
        actionKind: 'delete_negative',
        description: 'Delete rows containing negative values.',
      };
    }
    if (/\bimpute|guess|median|mean|average\b/.test(low)) {
      return {
        actionKind: 'nullify_outliers',
        description: 'Nullify negative values and re-impute from peers.',
      };
    }
    return {
      actionKind: 'set_negative_to',
      replacementValue: 0,
      description: 'Replace negative values with 0.',
    };
  }

  // 4. Cap / above / over / greater than threshold
  const aboveMatch = low.match(
    /(?:above|over|greater than|more than|exceeding|exceeds|>|>=)\s*(-?\d+(?:\.\d+)?)(?:.*?(?:to|with|as|=)\s*(-?\d+(?:\.\d+)?|null))?/
  );
  const capMatch = low.match(/\b(?:cap|clamp max|max)\b.*?\b(?:at|to)\s*(-?\d+(?:\.\d+)?)/);
  if (capMatch) {
    const threshold = Number(capMatch[1]);
    return {
      actionKind: 'cap_above',
      threshold,
      replacementValue: threshold,
      description: `Cap values above ${threshold} to ${threshold}.`,
    };
  }
  if (aboveMatch) {
    const threshold = Number(aboveMatch[1]);
    const targetRaw = aboveMatch[2];
    if (/\b(delete|remove|drop)\b/.test(low)) {
      return {
        actionKind: 'delete_above',
        threshold,
        description: `Delete rows where value > ${threshold}.`,
      };
    }
    if (targetRaw === 'null' || /\bnull(ify)?\b/.test(low)) {
      return {
        actionKind: 'nullify_above',
        threshold,
        description: `Set values > ${threshold} to NULL.`,
      };
    }
    const target = targetRaw !== undefined ? Number(targetRaw) : threshold;
    return {
      actionKind: 'cap_above',
      threshold,
      replacementValue: target,
      description: `Set values > ${threshold} to ${target}.`,
    };
  }

  // 5. Floor / below / under / less than threshold
  const belowMatch = low.match(
    /(?:below|under|less than|smaller than|<|<=)\s*(-?\d+(?:\.\d+)?)(?:.*?(?:to|with|as|=)\s*(-?\d+(?:\.\d+)?|null))?/
  );
  const floorMatch = low.match(/\b(?:floor|clamp min|min)\b.*?\b(?:at|to)\s*(-?\d+(?:\.\d+)?)/);
  if (floorMatch) {
    const threshold = Number(floorMatch[1]);
    return {
      actionKind: 'floor_below',
      threshold,
      replacementValue: threshold,
      description: `Raise values below ${threshold} to ${threshold}.`,
    };
  }
  if (belowMatch) {
    const threshold = Number(belowMatch[1]);
    const targetRaw = belowMatch[2];
    if (/\b(delete|remove|drop)\b/.test(low)) {
      return {
        actionKind: 'delete_below',
        threshold,
        description: `Delete rows where value < ${threshold}.`,
      };
    }
    if (targetRaw === 'null' || /\bnull(ify)?\b/.test(low)) {
      return {
        actionKind: 'nullify_below',
        threshold,
        description: `Set values < ${threshold} to NULL.`,
      };
    }
    const target = targetRaw !== undefined ? Number(targetRaw) : threshold;
    return {
      actionKind: 'floor_below',
      threshold,
      replacementValue: target,
      description: `Set values < ${threshold} to ${target}.`,
    };
  }

  // 6. Statistical outliers
  if (/\boutlier/.test(low)) {
    if (isDelete || /\b(delete|remove|drop)\b/.test(low)) {
      return {
        actionKind: 'delete_outliers_iqr',
        description: 'Delete statistical outlier rows outside IQR bounds.',
      };
    }
    if (/\bnull(ify)?\b/.test(low)) {
      return {
        actionKind: 'nullify_outliers',
        description: 'Set IQR statistical outliers to NULL.',
      };
    }
    return {
      actionKind: 'clamp_outliers_iqr',
      description: 'Clamp statistical outliers to IQR fence bounds.',
    };
  }

  // 7. Missing / NULL values
  if (/\b(missing|null|empty|blank|na|n\/a)\b/.test(low)) {
    if (/\b(delete|remove|drop)\b/.test(low)) {
      return {
        actionKind: 'delete_missing',
        description: 'Delete rows with missing or NULL values in this column.',
      };
    }
    if (/\b(impute|guess|peer|median|mean|average|mode)\b/.test(low)) {
      return {
        actionKind: 'impute_missing',
        description: 'Impute missing cells using peer-group average/mode.',
      };
    }
    const fillMatch = raw.match(/(?:with|to|as|=)\s*['"`]?([^'"`]+?)['"`]?$/i);
    if (fillMatch) {
      const valStr = fillMatch[1].trim();
      const numVal = Number(valStr);
      const val: string | number =
        valStr !== '' && !Number.isNaN(numVal) && /^-?\d+(?:\.\d+)?$/.test(valStr)
          ? numVal
          : valStr;
      return {
        actionKind: 'fill_missing_value',
        replacementValue: val,
        description: `Fill missing/NULL cells with ${String(val)}.`,
      };
    }
  }

  // 8. Text casing & whitespace rules
  if (/\b(upper\s*case|uppercase|all\s*caps|capital letters)\b/.test(low)) {
    return {
      actionKind: 'normalize_upper',
      description: 'Trim spaces and convert text to UPPERCASE.',
    };
  }
  if (/\b(lower\s*case|lowercase)\b/.test(low)) {
    return {
      actionKind: 'normalize_lower',
      description: 'Trim spaces and convert text to lowercase.',
    };
  }
  if (/\b(title\s*case|titlecase|normalize|capitalize|consistent casing)\b/.test(low)) {
    return {
      actionKind: 'normalize_title',
      description: 'Trim spaces and normalize text to Title Case.',
    };
  }
  if (/\b(trim|whitespace|extra spaces|leading spaces|trailing spaces)\b/.test(low)) {
    return {
      actionKind: 'trim_whitespace',
      description: 'Trim leading, trailing, and duplicate spaces.',
    };
  }

  return null;
}
