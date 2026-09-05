import type { SourceDiagnosticV1, SourceFactsV1, SourceLocationV1 } from '../contracts/program.js';

export interface VueImportBindingV1 {
  localName: string;
  importedName: string;
  specifier: string;
  location: SourceLocationV1;
}

export interface VueTemplateElementV1 {
  tag: string;
  staticIs?: string;
  location: SourceLocationV1;
}

export interface VueTemplateListenerV1 {
  childTag: string;
  eventName: string;
  handler?: string;
  modelArgument?: string;
  location: SourceLocationV1;
}

export interface VueCallFactV1 {
  callee: string;
  localBinding?: string;
  firstStaticString?: string;
  location: SourceLocationV1;
}

export interface VueStoreDeclarationV1 {
  exportName: string;
  localName: string;
  kind: 'pinia' | 'vuex';
  location: SourceLocationV1;
}

export interface VueEventFactV1 {
  eventName: string;
  source: 'defineEmits' | 'options-emits' | 'emit-call' | 'model';
  location: SourceLocationV1;
}

export interface VueSfcFactsV1 extends SourceFactsV1 {
  languageId: 'vue';
  componentId: string;
  imports: VueImportBindingV1[];
  optionsComponents: Record<string, string>;
  templateElements: VueTemplateElementV1[];
  templateListeners: VueTemplateListenerV1[];
  calls: VueCallFactV1[];
  stores: VueStoreDeclarationV1[];
  events: VueEventFactV1[];
  compilerDiagnostics: SourceDiagnosticV1[];
}

export function isVueSfcFacts(facts: SourceFactsV1): facts is VueSfcFactsV1 {
  return facts.languageId === 'vue' && 'componentId' in facts && 'templateElements' in facts;
}
