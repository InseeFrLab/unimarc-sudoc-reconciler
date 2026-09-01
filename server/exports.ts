/**
 * exports.ts — Génération des trois formats de sortie à partir d'une session.
 *
 *   buildXmlExport : XML Syracuse corrigé (mêmes "item/property" que l'entrée,
 *                    avec les corrections acceptées/modifiées appliquées).
 *   buildCsvExport : rapport d'écarts (une ligne par écart), séparateur ";".
 *   buildTxtExport : notices UNIMARC en notation texte WINIBW (async : va
 *                    chercher au Sudoc les XML manquants).
 *
 * Corps repris tels quels des routes /api/export d'origine ; seules les entrées
 * (session) et sorties (string) ont été isolées pour en faire des fonctions.
 */
import type { Session } from './sessions.ts';
import { fetchSudocRecord, unimarcXmlToText } from './marc.ts';
import { CHAMP_TYPE_SUPPORT, LIGNE_183_DEFAUT, PSEUDO_UNIMARC_FIELDS, SYRACUSE_TO_UNIMARC } from './syracuse.ts';

export function buildXmlExport(session: Session): string {
  // Fonction d'échappement XML
  const escapeXml = (s: any): string => {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  };

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push('<items>');

  // IMPORTANT : utiliser session.notices (source fiable peuplée par searchItems dans /api/upload)
  // et NON session.parsedXml.items.item (structure variable selon le XML source)
  const noticesToExport = session.notices || [];
  for (const notice of noticesToExport) {
    // Trouver le résultat correspondant (pour appliquer les modifications utilisateur)
    const result = session.results.find(r => r.identifiant === notice.identifiant);
    const itemType = notice.itemType || 'GESMARC';
    const properties = notice.properties || [];

    lines.push(`  <item type="${escapeXml(itemType)}">`);

    // Pour chaque property, déterminer la valeur finale
    for (const prop of properties) {
      const name = prop['@_name'] || '';
      const rank = prop['@_rank'] !== undefined ? String(prop['@_rank']) : '';
      const referentialType = prop['@_referentialType'] !== undefined ? String(prop['@_referentialType']) : '';
      const referentialName = prop['@_referentialName'] !== undefined ? String(prop['@_referentialName']) : '';
      let value = prop['@_value'] !== undefined ? String(prop['@_value']) : '';

      // Appliquer les modifications des écarts acceptés/modifiés
      if (result && Array.isArray(result.ecarts)) {
        const ecart = result.ecarts.find((e: any) => e.champ === name);
        if (ecart) {
          if (ecart.action === 'ACCEPTER' && ecart.valeurSudoc) {
            value = ecart.valeurSudoc;
          } else if (ecart.action === 'MODIFIER' && ecart.valeurModifiee !== undefined) {
            value = ecart.valeurModifiee;
          }
        }
      }

      // Pour les notices rattachées via SRU, mettre à jour "Identifiant d'origine" avec le nouveau PPN
      if (name === "Identifiant d'origine" && result?.statutGlobal === 'RATTACHE_SRU' && result.ppn) {
        value = result.ppn;
      }

      lines.push(
        `    <property name="${escapeXml(name)}" value="${escapeXml(value)}" rank="${escapeXml(rank)}" referentialType="${escapeXml(referentialType)}" referentialName="${escapeXml(referentialName)}" />`
      );
    }

    // Ajouter les champs ajoutés par l'utilisateur (ex: mots-clés RAMEAU via IA, compléments Sudoc)
    // qui n'existaient pas dans le XML d'origine
    if (result && Array.isArray(result.ecarts)) {
      const existingNames = new Set(properties.map((p: any) => p['@_name']));
      for (const ecart of result.ecarts) {
        // Les pseudo-champs (ex. « Type de support (183) ») ne concernent que la
        // notice UNIMARC : les écrire ici créerait une propriété inconnue de
        // Syracuse et ferait échouer le réimport.
        if (PSEUDO_UNIMARC_FIELDS.has(ecart.champ)) continue;
        if (!existingNames.has(ecart.champ) && 
            (ecart.action === 'ACCEPTER' || ecart.action === 'MODIFIER')) {
          const newVal = ecart.action === 'MODIFIER' 
            ? (ecart.valeurModifiee || '') 
            : (ecart.valeurSudoc || '');
          if (newVal) {
            lines.push(
              `    <property name="${escapeXml(ecart.champ)}" value="${escapeXml(newVal)}" rank="" referentialType="" referentialName="" />`
            );
          }
        }
      }
    }

    lines.push('  </item>');
  }

  lines.push('</items>');
  const xmlContent = lines.join('\n');
  return xmlContent;
}

export function buildCsvExport(session: Session): string {
  let csv = 'PPN;Identifiant_Syracuse;Champ;Valeur_Syracuse;Valeur_Sudoc;Statut;Action;Valeur_Finale;"Mots-clés IA"\n';
  session.results.forEach(r => {
    const aiKeywords = r.aiSuggestions && r.aiSuggestions.length > 0 ? `"${r.aiSuggestions.filter((kw:any)=>kw.selected).map((kw:any)=>kw.text).join('; ').replace(/"/g, '""')}"` : '""';
    
    // Si la notice n'a pas d'écarts ou est en attente
    if (!r.ecarts || r.ecarts.length === 0) {
      if (r.statutGlobal === 'EN_ATTENTE_RATTACHEMENT' || r.statutGlobal === 'ABSENT_SUDOC' || r.aiSuggestions?.length > 0) {
        csv += [r.ppn || '', r.identifiant || '', '', '', '', r.statutGlobal || '', '', '', aiKeywords].join(';') + '\n';
      }
      return;
    }
    
    // Filtre sur les écarts qui méritent d'être dans le rapport
    const ecartsAExporter = r.ecarts.filter((e: any) => 
      e.statut !== 'IDENTIQUE' && e.statut !== 'NON_VERIFIE' && e.statut !== 'ABSENT_SUDOC'
    );

    if (ecartsAExporter.length === 0 && r.aiSuggestions?.length > 0) {
       csv += [r.ppn || '', r.identifiant || '', '', '', '', r.statutGlobal || '', '', '', aiKeywords].join(';') + '\n';
       return;
    }

    ecartsAExporter.forEach((e: any) => {
      const finalVal = e.action === 'ACCEPTER' ? e.valeurSudoc : (e.action === 'MODIFIER' ? e.valeurModifiee : e.valeurSyracuse);
      csv += [
        r.ppn || '', r.identifiant || '', e.champ || '',
        `"${(e.valeurSyracuse || '').replace(/"/g, '""')}"`,
        `"${(e.valeurSudoc || '').replace(/"/g, '""')}"`,
        e.statut || '', e.action || '',
        `"${(finalVal || '').replace(/"/g, '""')}"`,
        aiKeywords
      ].join(';') + '\n';
    });
  });
  return '\uFEFF' + csv;
}

export async function buildTxtExport(session: Session): Promise<string> {
  const noticesText: string[] = [];
  
  for (const result of session.results) {
    if (!result.sudocXml && result.ppn) {
       try {
         const xml = await fetchSudocRecord(result.ppn);
         if (xml) result.sudocXml = xml;
       } catch (e) {
         console.error(`Impossible de récupérer le XML pour PPN ${result.ppn}`);
       }
    }

    // N'exporter que les notices avec données Sudoc disponibles 
    // (Catégorie A trouvées, ou Catégorie B rattachées via SRU)
    if (!result.sudocXml) continue;
    
    try {
      let unimarcText = unimarcXmlToText(result.sudocXml);
      if (!unimarcText) continue;
      
      // Appliquer les corrections utilisateur sur le texte UNIMARC
      // Pour chaque écart accepté ou modifié, remplacer la valeur dans la zone concernée
      if (Array.isArray(result.ecarts)) {
        for (const ecart of result.ecarts) {
          if (ecart.action !== 'ACCEPTER' && ecart.action !== 'MODIFIER') continue;
          const newValue = ecart.action === 'MODIFIER' 
            ? (ecart.valeurModifiee || '') 
            : (ecart.valeurSudoc || '');
          if (!newValue) continue;
          
          // Écart portant ses propres sous-zones (fusion de la collation 215) :
          // on réécrit la zone complète, sinon la valeur concaténée irait dans $a
          // et laisserait $c en doublon.
          if (ecart.unimarc && ecart.action === 'ACCEPTER') {
            const { tag, subfields } = ecart.unimarc as { tag: string; subfields: Record<string, string> };
            const parts = Object.entries(subfields)
              .filter(([, v]) => v)
              .map(([code, v]) => `$${code}${v}`)
              .join('');
            if (parts) {
              const ligneRegex = new RegExp(`^${tag} (..)\\$.*$`, 'm');
              const trouvee = unimarcText.match(ligneRegex);
              unimarcText = trouvee
                ? unimarcText.replace(ligneRegex, `${tag} ${trouvee[1]}${parts}`)
                : `${unimarcText}\n${tag} ##${parts}`;
            }
            continue;
          }

          // Mapping Syracuse → tag UNIMARC + subfield concerné
          const target = SYRACUSE_TO_UNIMARC[ecart.champ];
          if (!target) continue;
          
          // Remplacer la valeur dans la première zone correspondante
          // Les controlfields commencent par 00 (sauf 000) et n'ont pas d'indicateurs
          const isControl = target.tag.startsWith('00') && target.tag !== '000';
          const indicatorPattern = isControl ? ' ' : ' ..';
          
          const regex = new RegExp(
            `^(${target.tag}${indicatorPattern}\\$${target.code})[^\\$]*`, 
            'm'
          );
          if (regex.test(unimarcText)) {
            unimarcText = unimarcText.replace(regex, `$1${newValue}`);
          } else {
            // La zone n'existait pas dans le XML d'origine : ajouter une nouvelle ligne UNIMARC
            const newInd = isControl ? ' ' : ' ##';
            unimarcText += `\n${target.tag}${newInd}$${target.code}${newValue}`;
          }
        }
      }
      
      // Zone 183 (type de support) proposée quand la notice Sudoc n'en a pas :
      // ajoutée seulement si la documentaliste a laissé/mis l'action à ACCEPTER.
      const ecart183 = Array.isArray(result.ecarts)
        ? result.ecarts.find((e: any) => e.champ === CHAMP_TYPE_SUPPORT)
        : undefined;
      if (ecart183 && (ecart183.action === 'ACCEPTER' || ecart183.action === 'MODIFIER') && !/^183 /m.test(unimarcText)) {
        const ligne183 = (ecart183.action === 'MODIFIER' ? (ecart183.valeurModifiee || '') : LIGNE_183_DEFAUT).trim();
        if (ligne183) unimarcText += `\n${ligne183}`;
      }

      // Si la notice est rattachée via SRU, mettre à jour la zone 003 (PPN)
      if (result.statutGlobal === 'RATTACHE_SRU' && result.ppn) {
        const ppnRegex = /^003 .*/m;
        if (ppnRegex.test(unimarcText)) {
          unimarcText = unimarcText.replace(ppnRegex, `003 ${result.ppn}`);
        } else {
          unimarcText += `\n003 ${result.ppn}`;
        }
      }
      
      // Ajouter les mots-clés générés par l'IA en tant que propositions à valider
      if (result.aiSuggestions && result.aiSuggestions.length > 0) {
        for (const kw of result.aiSuggestions) {
          if (kw && kw.selected) {
            unimarcText += `\n606 ##$a${kw.text}$2rameau$9Suggestion IA à valider`;
          }
        }
      }
      
      noticesText.push(unimarcText);
    } catch (err: any) {
      console.error(`Erreur export TXT notice ${result.identifiant}:`, err.message);
      // On continue avec les autres notices
    }
  }
  
  if (noticesText.length === 0) {
    noticesText.push("Aucune notice a exporter. Verifiez la validite des notices et la dispo des donnees Sudoc.");
  }

  const separator = '\n\n----------------------------------------\n\n';
  const fullText = noticesText.join(separator);
  return fullText;
}
