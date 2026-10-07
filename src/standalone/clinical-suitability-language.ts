/** Negative routing only. These complete requests establish neither a clinical
 * recommendation nor vaccination eligibility; symptoms never select a service. */
export function asksClinicalSuitability(text: string): boolean {
 const value = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, "");
 if (!value || value.length > 350 || /[\n\r"“”]/.test(value)) return false;
 const condition = "(?:recurring shoulder dislocations after a seizure|my child's autism|my vertigo|my lower back after a kidney stone|my grandson's shoulder instability)";
 return new RegExp(`^(?:can (?:an osteopath|the clinician|the doctor) (?:fix|help|treat) ${condition}|would an osteopath help ${condition}|will this treatment help ${condition})$`).test(value) ||
  /^(?:can|will) (?:the clinician|the doctor|you) (?:perform an epley man(?:oe|eu)uvre|give (?:me )?an injection) on my first (?:visit|appointment)$/.test(value) ||
  /^(?:should i take (?:codeine|medication|painkillers) for (?:this|my) pain|can i stop my medication before (?:the|my) appointment)$/.test(value) ||
  /^(?:am i eligible for a free nhs flu (?:vaccination|jab)|does being a carer mean i qualify for an nhs flu (?:vaccination|jab))$/.test(value) ||
  /^is (?:an hour of massage suitable after my hip replacement|the clinician the right person to treat my vertigo)$/.test(value) ||
  /^i have pain and swelling after nail surgery\. can you recommend treatment$/.test(value) ||
  /^can you recommend exercises for my grandson's shoulder instability$/.test(value);
}
