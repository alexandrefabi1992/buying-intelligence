'use strict';

const HELP = {

  quickstart: {
    title: 'Démarrage rapide',
    icon: '🚀',
    summary: "Vue d'ensemble de l'application et flux de travail recommandé pour la préparation d'une saison.",
    sections: [
      {
        heading: "Comment est structurée l'application",
        body: "Buying Intelligence est organisée en 6 sections accessibles depuis la barre de navigation :\n\n- **📊 Budget** : calcul automatique du budget recommandé par marque\n- **🔄 NOS** : suivi et réapprovisionnement des articles permanents\n- **📐 Courbes tailles** : distribution des ventes par taille\n- **🔀 Transferts** : recommandations de mouvements inter-boutiques\n- **📝 Création de budget** : saisie et validation des budgets finaux\n- **⚙️ Paramètres** : configuration des saisons et des règles de calcul\n- **⚡ Vélocité** : performance des articles en cours de saison (page séparée)",
      },
      {
        heading: "Flux de travail recommandé — préparation d'une saison",
        body: "**1. Configurer la saison cible** (Paramètres → Saisons)\nDéfinir le code, les dates de réception et de vente pour la nouvelle saison.\n\n**2. Analyser le budget recommandé** (Budget → sélectionner la saison)\nConsulter les budgets par marque. Identifier les hausses, baisses et alertes.\n\n**3. Consulter le détail par marque**\nCliquer sur une marque pour voir le détail par saison de référence, le sell-through historique et la courbe de ventes.\n\n**4. Vérifier les courbes tailles** (section Courbes tailles)\nValider la répartition des commandes par taille pour chaque marque.\n\n**5. Saisir les budgets validés** (Création de budget)\nEntrer les montants finaux par marque, drop et boutique.\n\n**6. Surveiller en cours de saison** (Vélocité)\nSuivre le rythme de vente semaine par semaine et agir rapidement.",
      },
      {
        heading: "Glossaire des termes clés",
        body: "- **Saison** : période de collection identifiée par un code (ex. P26 = Printemps 2026, A26 = Automne 2026).\n- **Sell-through (ST)** : % des articles reçus qui ont été vendus. ST = ventes / réceptions × 100.\n- **Réceptions impliquées** : estimation des articles commandés = articles vendus + stock restant taggé avec la saison.\n- **Base blendée** : moyenne des réceptions et des ventes — ancre le budget à la demande réelle, pas seulement aux achats passés.\n- **Carryover** : stock invendu d'une saison qui se reportera sur la suivante. Déduit du budget net.\n- **Drop** : livraison planifiée au sein d'une saison (ex. Drop 1 = janvier, Drop 2 = mars).\n- **NOS** : Never Out of Stock — articles permanents non liés à une saison.\n- **Facteur de récence** : poids accordé aux saisons récentes dans la moyenne. Un facteur de 2 signifie que la saison la plus récente compte 2× plus que la précédente.",
      },
      {
        heading: "L'assistant IA",
        body: "Le bouton de l'assistant IA (en bas à droite de l'écran) donne accès à un chatbot capable de :\n- Interroger directement la base de données (ventes, stock, sell-through)\n- Calculer des budgets ou des courbes tailles à la demande\n- Recommander des transferts\n- Répondre à des questions sur le fonctionnement de l'application\n\nExemples de questions : *« Quel est le ST de la marque Brax en P26 ? »*, *« Quels articles de Saint-Bruno devraient être transférés à Fan Club ? »*, *« Comment fonctionne le carryover ? »*",
      },
    ],
  },

  budget: {
    title: 'Budget saisonnier',
    icon: '📊',
    summary: "Calcule le budget d'achat recommandé par marque pour une saison future, à partir des historiques de réceptions et de ventes des saisons précédentes.",
    sections: [
      {
        heading: 'Comment lire le tableau',
        body: "Chaque ligne représente une marque. Les colonnes principales :\n\n- **Réceptions impliquées** : coût estimé des articles commandés pour les saisons de référence (vendus + stock restant taggé avec la saison). C'est un proxy des réceptions fournisseur sans dépendre des bons de commande.\n- **ST moyen pondéré** : sell-through moyen sur les N saisons de référence, les saisons récentes pesant plus lourd.\n- **Tendance** : direction des réceptions d'une saison à l'autre. ↑ hausse > 10 %, ↓ baisse > 10 %, → stable.\n- **Multiplicateur** : facteur appliqué selon le palier de ST (ex : ST ≥ 65 % → ×1.10).\n- **Budget ajusté** : base pondérée × multiplicateur.\n- **Carryover** : stock restant de la saison précédente qui sera encore disponible.\n- **Budget net** : budget ajusté − (carryover × taux de déduction). C'est le montant à commander.",
      },
      {
        heading: 'Logique de calcul étape par étape',
        body: "**Étape 1 — Identifier les saisons de référence**\nSi la saison cible est P27, on utilise P26, P25, P24 (les 3 printemps précédents). Le paramètre *Nb saisons de référence* contrôle ce nombre.\n\n**Étape 2 — Calculer la base blendée par saison**\nBase = (réceptions impliquées + ventes projetées) ÷ 2\nPourquoi la moyenne ? Les réceptions seules perpétuent les erreurs d'achat passées. La base blendée corrige vers la demande réelle.\n\n**Étape 3 — Projection si saison en cours**\nSi une saison de référence est encore en cours (ex. P26 à 57 % de sa période), les ventes sont projetées jusqu'à la fin en s'appuyant sur la vélocité historique des saisons passées durant la même fenêtre restante.\n\n**Étape 4 — Moyenne pondérée par récence**\nPoids = facteur_récence^(position). Avec un facteur de 2 sur 3 saisons : P26 pèse 4, P25 pèse 2, P24 pèse 1.\n\n**Étape 5 — Appliquer le multiplicateur**\nSelon le ST moyen pondéré, le multiplicateur est lu dans les paliers configurés (Paramètres).\n\n**Étape 6 — Déduire le carryover**\nBudget net = budget ajusté − (stock restant saison précédente × taux carryover).",
      },
      {
        heading: 'Filtres et options',
        body: "- **Saison cible** : la saison pour laquelle on prépare le budget.\n- **Boutiques** : filtrer par une ou plusieurs boutiques. Par défaut, toutes les boutiques consolidées.\n- **Collections / Tailles** : filtrer les produits par collection ou taille (tags Lightspeed).\n- **Export CSV** : exporter le tableau pour un usage externe (Excel, partage).\n- **Clic sur une marque** : ouvre la page détail de la marque avec le historique complet.",
      },
      {
        heading: "Questions fréquentes",
        body: "**Pourquoi une marque n'apparaît-elle pas ?**\nSes produits ne sont pas taggés avec le code de la saison cible dans Lightspeed. Vérifier les tags produits.\n\n**Pourquoi le budget est-il 0 ou très faible ?**\nLe ST des saisons de référence est en dessous du seuil le plus bas (< 35 %) → multiplicateur ×0.50, ou le carryover dépasse le budget ajusté.\n\n**Pourquoi les chiffres diffèrent de Lightspeed ?**\nLightspeed affiche les « Stocks reçus » comme dépletion (reçus − restants), pas comme des ventes. Buying Intelligence utilise directement les lignes de vente.\n\n**Comment forcer un budget différent du recommandé ?**\nUtiliser la section *Création de budget* pour saisir le montant validé manuellement.",
      },
    ],
  },

  nos: {
    title: 'NOS — Never Out of Stock',
    icon: '🔄',
    summary: "Suivi et réapprovisionnement des articles permanents qui doivent toujours être disponibles en stock.",
    sections: [
      {
        heading: "Qu'est-ce qu'un article NOS ?",
        body: "Un article NOS (Never Out of Stock) est un produit permanent — il n'est pas lié à une saison, il est vendu toute l'année. Exemples typiques : un jean de base, une chemise blanche classique, des accessoires récurrents.\n\nLes articles NOS sont identifiés par un tag spécifique dans Lightspeed (ex. \"NOS\"). Ce tag est configurable dans Paramètres → Configuration boutique.",
      },
      {
        heading: 'Colonnes du tableau',
        body: "- **Marque / Référence** : marque et description de l'article.\n- **Stock total** : stock actuel toutes boutiques confondues (ou filtrée par boutique).\n- **Ventes N semaines** : total des ventes sur la période de référence choisie.\n- **Vente/semaine** : rythme de vente hebdomadaire moyen.\n- **Semaines de couverture** : à ce rythme, combien de semaines le stock actuel peut tenir.\n- **Action** : recommandation — Réapprovisionner (stock < seuil), OK (couverture suffisante).",
      },
      {
        heading: 'Comment interpréter et agir',
        body: "**Seuil de réapprovisionnement**\nSi le stock couvre moins de N semaines (configurable), l'article est signalé. La logique est : si le délai de livraison fournisseur est 6 semaines, il faut commander dès que la couverture passe sous 8 semaines.\n\n**Articles en rouge**\nStock insuffisant par rapport au rythme de vente. Agir rapidement — contacter le fournisseur ou faire un transfert depuis une boutique mieux stockée.\n\n**Articles en vert**\nCouverture correcte. Surveiller si le rythme de vente accélère.",
      },
      {
        heading: 'Filtres disponibles',
        body: "- **Boutiques** : voir le stock et les ventes boutique par boutique ou consolidés.\n- **Collections** : filtrer par collection (tag Lightspeed).\n- **Semaines de référence** : nombre de semaines passées pour calculer le rythme de vente (défaut : 12 semaines).",
      },
    ],
  },

  sizes: {
    title: 'Courbes tailles',
    icon: '📐',
    summary: "Distribution des ventes par taille pour définir la répartition optimale d'une commande et éviter les ruptures ou surplus par taille.",
    sections: [
      {
        heading: "À quoi ça sert",
        body: "Quand on commande 100 unités d'un article, combien en S, M, L, XL ?\n\nLa section Courbes tailles répond à cette question en analysant la distribution historique des ventes. Si 35 % des ventes d'une marque sont en taille M, on commande 35 unités en M sur 100.\n\nC'est aussi utile pour détecter des déséquilibres : si le stock en M est épuisé mais que L est plein, c'est que la courbe de commande ne correspond pas à la courbe de vente.",
      },
      {
        heading: 'Lecture du tableau',
        body: "Chaque ligne est une marque. Chaque colonne est une taille. La valeur dans chaque cellule est le **pourcentage de ventes** dans cette taille sur la période sélectionnée.\n\nLa ligne **Stock en main** (si affichée) montre la distribution actuelle du stock. L'écart entre les deux lignes indique les tailles sur- ou sous-représentées.\n\nExemple : ventes M = 38 %, stock M = 20 % → taille M sous-stockée, risque de rupture.",
      },
      {
        heading: 'Comment utiliser pour une commande',
        body: "1. Sélectionner la saison de référence (ex. P26 pour préparer P27).\n2. Filtrer par marque si nécessaire.\n3. Lire la ligne de distribution pour la marque.\n4. Multiplier le budget total par ces pourcentages pour obtenir le nombre d'unités par taille.\n\nExemple : budget 50 unités, distribution S=15%, M=35%, L=35%, XL=15% → commander 7.5/17.5/17.5/7.5 → arrondir à 8/17/17/8.",
      },
      {
        heading: 'Filtres disponibles',
        body: "- **Saison** : sélectionner la saison de référence.\n- **Boutique** : analyser la distribution par boutique spécifique.\n- **Catégorie** : filtrer par type de produit (pantalon, chemise…).\n- **Genre** : filtrer homme / femme si applicable.\n- **Export CSV** : exporter la courbe pour usage dans un bon de commande.",
      },
    ],
  },

  transfers: {
    title: 'Transferts / Actions',
    icon: '🔀',
    summary: "Recommandations automatiques de transferts inter-boutiques pour équilibrer les stocks, réduire les immobilisations et éviter les ruptures.",
    sections: [
      {
        heading: 'Comment les recommandations sont générées',
        body: "L'algorithme identifie les articles qui réunissent ces deux conditions simultanément :\n\n**Boutique source (trop de stock)** :\n- Stock élevé par rapport aux ventes récentes\n- Rythme de vente faible (les semaines de couverture dépassent un seuil)\n\n**Boutique destination (manque de stock)** :\n- Rupture ou stock très bas\n- Ventes récentes actives (il y a une demande)\n\nLe transfert recommandé est chiffré en unités (combien déplacer) et en valeur coût.",
      },
      {
        heading: 'Priorité et ordre des recommandations',
        body: "Les recommandations sont triées par **valeur du stock dormant décroissante** — les articles les plus coûteux à immobiliser apparaissent en premier.\n\nUn article à 80 $ de coût unitaire avec 10 unités en surplus = 800 $ d'immobilisation. C'est prioritaire sur un article à 20 $ avec 5 unités.\n\nLa valeur de la recommandation = coût × unités à transférer.",
      },
      {
        heading: 'Comment agir sur une recommandation',
        body: "1. **Vérifier la recommandation** : cliquer sur l'article pour voir le détail boutique par boutique.\n2. **Valider la logique** : est-ce que la boutique destination a vraiment besoin de cet article ? (taille adaptée à la clientèle, etc.)\n3. **Initier le transfert** dans Lightspeed POS.\n4. **Marquer comme traité** si applicable.\n\nNote : les articles transférés ne comptent ni comme réception ni comme vente dans le calcul du budget de la boutique émettrice — c'est intentionnel.",
      },
      {
        heading: 'Filtres disponibles',
        body: "- **Boutique source** : voir les articles à envoyer depuis une boutique spécifique.\n- **Boutique destination** : voir les articles à recevoir dans une boutique.\n- **Marque** : filtrer par fournisseur.\n- **Nb semaines de référence** : fenêtre temporelle pour évaluer le rythme de vente.\n- **Valeur minimum** : ignorer les recommandations sous un seuil de valeur.",
      },
    ],
  },

  plan: {
    title: 'Création de budget',
    icon: '📝',
    summary: "Outil de saisie, planification et validation des budgets d'achat par saison, marque et drop (livraison).",
    sections: [
      {
        heading: "Vue d'ensemble",
        body: "La section Budget calcule une recommandation — la section Création de budget est l'endroit où l'acheteur saisit les montants **validés et engagés**.\n\nC'est ici que se passe la confirmation finale : après avoir consulté le recommandé, négocié avec les fournisseurs et ajusté, on entre le budget définitif par marque.",
      },
      {
        heading: 'Les cinq indicateurs de la barre de totaux',
        body: "La barre grise en haut affiche cinq chiffres. Voici leur signification exacte :\n\n| Indicateur | Ce qu'il représente |\n|---|---|\n| **Recommandé** | Budget calculé par l'algorithme (budget net × toutes les marques visibles), plus redistribution proportionnelle des marques que tu as retirées du plan. C'est la base de référence — aucune intervention humaine. |\n| **Budget suggéré** | Même calcul, **mais avec tes ajustements manuels**. Si tu as changé le montant d'une marque dans la colonne « Budget suggéré », c'est cette valeur qui est prise en compte. Tant qu'il n'y a aucun ajustement, Recommandé = Suggéré. |\n| **Solde** | Différence entre Recommandé et Suggéré. Apparaît uniquement si tu as des ajustements actifs. Positif = tu as réduit par rapport à l'algo. Négatif = tu as augmenté. |\n| **Planifié** | Total des montants réellement saisis dans les drops (commandes engagées par marque × boutique). |\n| **Écart** | Planifié − Suggéré. Indique combien il reste à confirmer pour atteindre ton budget suggéré. |\n\n**Recommandé vs Suggéré — en pratique**\nSi tu laisses la colonne « Budget suggéré » intacte, les deux chiffres sont identiques. Dès que tu modifies manuellement une ligne (exemple : tu montes Fradi de 8 500 $ à 10 000 $), le Suggéré monte en conséquence et un Solde apparaît pour te montrer l'écart. Le bouton ↺ à gauche du champ réinitialise la marque à son montant recommandé.\n\nLa petite valeur grise affichée sous certains champs (ex. `rec. 8 524 $`) est le montant recommandé d'origine — elle reste visible pour que tu ne perdes jamais la référence algorithmique.",
      },
      {
        heading: 'Concept de drop',
        body: "Un **drop** est une livraison planifiée au sein d'une saison. Certains fournisseurs livrent en plusieurs fois — Drop 1 en janvier, Drop 2 en mars, Drop 3 en mai.\n\nCela permet de :\n- Répartir le budget dans le temps (trésorerie)\n- Suivre les livraisons distinctement\n- Attacher des documents différents par livraison\n\nChaque marque peut avoir un nombre illimité de drops. Par défaut, une marque a un seul drop (Drop 1).",
      },
      {
        heading: 'Saisie des montants',
        body: "- Les montants sont en **coût d'achat** (pas en prix de vente).\n- Saisir par marque × drop × boutique.\n- Les totaux par marque, par drop et global se calculent automatiquement.\n- Un montant peut être saisi différemment par boutique si les achats sont gérés séparément.\n- Les budgets saisis sont persistés en base de données — ils restent disponibles d'une session à l'autre.",
      },
      {
        heading: 'Documents attachés',
        body: "Pour chaque marque × drop, il est possible d'attacher des fichiers :\n- Fiches techniques fournisseur\n- Confirmations de commande\n- Lookbooks de saison\n- Tableaux de prix\n\nCes documents sont stockés directement dans l'application et accessibles par toute l'équipe.",
      },
      {
        heading: 'Suivi et export',
        body: "- **Comparaison recommandé / saisi** : le budget recommandé par l'algorithme est affiché en regard du budget saisi pour faciliter la validation.\n- **Export** : le budget complet peut être exporté en CSV pour intégration dans un système comptable ou partage avec un fournisseur.",
      },
    ],
  },

  params: {
    title: 'Paramètres',
    icon: '⚙️',
    summary: "Configuration des saisons, des paliers de multiplicateurs et des paramètres de calcul du budget.",
    sections: [
      {
        heading: 'Configuration des saisons',
        body: "Chaque saison est définie par :\n- **Code** : identifiant court (ex. \"p26\").\n- **Étiquette** : nom affiché (ex. \"Printemps 2026\").\n- **Tag Lightspeed** : le tag appliqué aux produits dans Lightspeed pour les associer à cette saison (ex. \"p26\"). Doit correspondre exactement aux tags utilisés dans Lightspeed.\n- **Début des réceptions** : date à partir de laquelle on comptabilise les réceptions de la saison.\n- **Début des ventes** : début de la fenêtre de vente.\n- **Fin des ventes** : fin de la fenêtre de vente.\n\nCes dates délimitent les fenêtres de calcul. Une saison mal configurée donnera des budgets incorrects.",
      },
      {
        heading: 'Paliers de multiplicateurs',
        body: "Chaque palier définit la règle **ST → multiplicateur** :\n\n| ST moyen | Multiplicateur | Interprétation |\n|----------|---------------|----------------|\n| ≥ 80 % | ×1.25 | Augmenter |\n| ≥ 65 % | ×1.10 | Légère hausse |\n| ≥ 50 % | ×1.00 | Reconduire |\n| ≥ 35 % | ×0.80 | Réduire |\n| < 35 % | ×0.50 | Couper |\n\nCes paliers sont entièrement modifiables. Les seuils et multiplicateurs peuvent être ajustés selon la stratégie d'achat.",
      },
      {
        heading: 'Paramètres de calcul',
        body: "**Nb saisons de référence** (défaut : 3)\nCombien de saisons passées entrent dans le calcul. Plus le nombre est élevé, plus la moyenne est stable mais moins réactive aux tendances récentes.\n\n**Facteur de récence** (défaut : 2.0)\nPoids accordé aux saisons récentes. Avec 3 saisons et un facteur de 2 :\n- Saison N-1 → poids 4 (2²)\n- Saison N-2 → poids 2 (2¹)\n- Saison N-3 → poids 1 (2⁰)\nTotal = 7. La saison la plus récente compte pour 57 % du budget.\n\n**Taux carryover** (défaut : 50 %)\nPourcentage du stock restant déduit du budget net. Un taux de 50 % signifie que si 10 000 $ de stock d'une saison restent invendus, 5 000 $ sont déduits du prochain budget.\n\n**Taux par boutique**\nOption pour définir un taux de carryover différent par boutique — utile si certaines boutiques ont une meilleure capacité d'écoulement.",
      },
      {
        heading: 'Configuration boutique (onboarding)',
        body: "La page Configuration (⚙ dans la nav) permet de définir :\n- Le nom de la boutique / tenant\n- Le champ utilisé pour le type de produit (category, tag ou description)\n- L'activation et les valeurs du filtre genre (homme/femme)\n- Le tag identifiant les articles NOS\n- Les identifiants de connexion Lightspeed",
      },
    ],
  },

  velocity: {
    title: 'Vélocité',
    icon: '⚡',
    summary: "Analyse de performance des articles en cours de saison — sell-through par semaine, pourcentage plein tarif et recommandations d'action.",
    sections: [
      {
        heading: 'Métriques par semaine',
        body: "La vélocité mesure le rythme de vente par rapport au stock initial (articles reçus au début de la saison).\n\n- **ST S4** : % du stock initial vendu après 4 semaines.\n- **ST S7** : % vendu après 7 semaines.\n- **ST S10** : % vendu après 10 semaines.\n- **ST S14** : % vendu après 14 semaines.\n- **ST final** : % total vendu depuis le début de la saison.\n- **% plein tarif** : part des ventes faites sans remise ≥ 10 %. Un % élevé signifie que les clients achètent sans attendre les soldes.",
      },
      {
        heading: 'Rating A → D',
        body: "Chaque article reçoit un rating basé sur la combinaison ST et % plein tarif :\n\n- **A (vert)** : ST et plein tarif excellents — article performant, peut justifier un réapprovisionnement.\n- **B (bleu)** : performance correcte — surveiller.\n- **C (orange)** : ST ou plein tarif faible — action recommandée dans les prochaines semaines.\n- **D (rouge)** : les deux métriques faibles — écoulement urgent nécessaire.",
      },
      {
        heading: "Actions recommandées",
        body: "Selon le rythme de vente, le stock restant et la progression de la saison :\n\n- **Réapprovisionner** : la demande est forte, le stock va manquer avant la fin de la saison.\n- **Monitorer** : performance normale, rien à faire maintenant.\n- **Promouvoir** : ventes en dessous du rythme attendu — envisager une mise en avant ou une remise légère.\n- **Solder** : stock élevé, saison avancée — déclencher des soldes pour écouler.\n- **Solde urgent** : stock très élevé, saison en fin de course — agir immédiatement.",
      },
      {
        heading: 'Vues disponibles',
        body: "**Vue par marque**\nAgrège tous les articles d'une marque. Donne une vision macro du ST de la collection complète.\n\n**Vue par matrice**\nUne matrice est un modèle décliné en plusieurs tailles/couleurs. Cette vue montre la performance de chaque modèle individuellement (ex. le pantalon A45118 en 5 tailles).\n\n**Vue par article**\nDétail unitaire — une ligne par variante (taille + couleur). Permet de voir exactement quels coloris ou tailles performent et lesquels stagnent.",
      },
      {
        heading: 'Cas d\'usage typiques',
        body: "**Réunion hebdomadaire** : passer en revue tous les articles D et C — décider des actions de la semaine.\n\n**Préparation des soldes** : lister tous les articles à ST < 50 % avec stock > 0 — construire la liste de soldes.\n\n**Réapprovisionnement** : identifier les articles A avec stock < 2 semaines de couverture — passer commande rapide.\n\n**Bilan de saison** : à la fin de la saison, analyser les courbes ST pour ajuster les budgets de la saison suivante.",
      },
    ],
  },

  accounting: {
    title: 'Comptabilité fournisseurs',
    icon: '💰',
    summary: "Aide à la décision escompte vs terme complet pour chaque fournisseur, basée sur le rendement annualisé de l'escompte et le coût du capital.",
    sections: [
      {
        heading: 'La décision escompte vs terme complet',
        body: "La plupart des fournisseurs offrent un **escompte de paiement rapide** : par exemple « 2/10 n/60 » signifie 2% de réduction si on paie en 10 jours plutôt qu'en 60 jours.\n\nLa question est : vaut-il mieux prendre cet escompte (payer tôt et économiser 2%) ou garder l'argent 50 jours de plus (et le placer ou l'utiliser ailleurs) ?\n\nLa réponse dépend du **rendement annualisé** de l'escompte comparé au **coût du capital** de l'entreprise.",
      },
      {
        heading: 'Formule du rendement annualisé',
        body: "**Formule :**\n\n`Rendement = (escompte% ÷ (1 − escompte%)) × (365 ÷ (net_jours − escompte_jours))`\n\n**Exemple : 2/10 n/60**\n- Escompte = 2%\n- Jours gagnés = 60 − 10 = 50 jours\n- Rendement = (2 ÷ 98) × (365 ÷ 50) = **14,9% par an**\n\nSi le coût du capital est à 8%/an : **prendre l'escompte** (14,9% > 8%).\nSi le coût du capital est à 20%/an : **terme complet** (14,9% < 20%).\n\nNote : la division par `(1 − escompte%)` reflète que l'escompte est calculé sur le montant brut — sans cette correction, le rendement serait légèrement sous-estimé.",
      },
      {
        heading: 'Vélocité et délai de financement',
        body: "La **vélocité** (jours pour écouler le stock au rythme des 90 derniers jours) sert à qualifier la recommandation :\n\n- Si `net_days > vélocité` → le fournisseur finance la vente (tu vends avant d'avoir à payer). C'est la situation idéale.\n- Si `net_days < vélocité` → tu dois payer avant d'avoir vendu. L'escompte sort encore plus tôt le cash d'un stock qui tarde à se vendre — un avertissement ⚠ est affiché.\n\nLa vélocité n'inverse pas la recommandation (si le rendement > coût du capital, prendre l'escompte reste rentable) mais elle signale une contrainte de trésorerie à surveiller.",
      },
      {
        heading: 'Saisir les termes fournisseur',
        body: "Cliquer sur la colonne **Termes fournisseur** d'une marque pour ouvrir le panneau de saisie. Formats acceptés :\n\n- `2/10 n/60` — escompte 2% si payé en 10 jours, net à 60 jours\n- `2% 10 jours net 60` — même chose, format long\n- `n/30` ou `net 30` — pas d'escompte, terme de 30 jours\n\nUn **override de marge** peut être saisi si la marge calculée depuis les ventes ne reflète pas la réalité (ex: marge négociée contractuellement différente).",
      },
      {
        heading: 'Coût du capital',
        body: "Le coût du capital est le paramètre central de la comparaison. Il représente ce que vaut l'argent pour l'entreprise — soit le taux d'emprunt si on est en découvert, soit le rendement alternatif de la trésorerie.\n\n**Défaut : 8%/an.** À modifier dans l'en-tête de la page selon la situation financière réelle. La valeur est sauvegardée et s'applique à toutes les marques.",
      },
    ],
  },

  'inv-history': {
    title: 'Historique stock',
    icon: '📦',
    summary: "Suivi de l'évolution du stock dans le temps — unités, valeur au coût et valeur au détail — par boutique et par marque.",
    sections: [
      {
        heading: "Comment ça fonctionne",
        body: "Chaque nuit, lors de la synchronisation Lightspeed, un **snapshot** (photo) du stock est pris et enregistré. Ce snapshot capture exactement le nombre d'unités et la valeur de chaque article dans chaque boutique à ce moment précis.\n\nL'historique débute à la date du **premier snapshot** (24 juillet 2026). Il n'est pas possible de consulter le stock avant cette date — les données n'existent pas rétroactivement.\n\nLes snapshots couvrent une fenêtre glissante de **400 jours** en détail quotidien. Au-delà, les données sont consolidées en moyennes mensuelles et conservées indéfiniment.",
      },
      {
        heading: "Les trois métriques",
        body: "| Métrique | Ce qu'elle mesure |\n|---|---|\n| **Unités en stock** | Nombre total d'articles physiquement en boutique à la date sélectionnée. |\n| **Valeur au coût** | Unités × coût d'achat unitaire (prix payé au fournisseur). Utile pour évaluer l'immobilisation de capital. |\n| **Valeur au détail** | Unités × prix de vente. Indique le chiffre d'affaires potentiel si tout était vendu au plein tarif. |\n\nLa valeur est calculée au coût unitaire **du jour du snapshot** — elle ne change pas si les prix sont modifiés ultérieurement. C'est une photo figée, pas une valorisation comptable.",
      },
      {
        heading: "Filtres disponibles",
        body: "- **Date** : sélectionner n'importe quel jour depuis le premier snapshot. Les KPI et le tableau de répartition se mettent à jour.\n- **Boutique** : filtrer sur une seule boutique. Par défaut, toutes les boutiques sont incluses.\n- **Marque** : filtrer sur une marque précise (ex. « Brax »). Combinable avec le filtre boutique.\n- **Métrique** : choisir ce que le graphique affiche (unités, valeur coût ou valeur détail).\n- **Granularité** : Quotidien (une point par jour) ou Mensuel (moyenne des jours du mois).",
      },
      {
        heading: "Le tableau de répartition",
        body: "Sans filtre boutique : le tableau affiche la **répartition par boutique**. Cliquer sur une boutique ouvre le détail **par marque** pour cette boutique (bouton ← pour revenir).\n\nAvec un filtre boutique : le tableau affiche directement la répartition **par marque** dans cette boutique.\n\nAvec un filtre marque : les totaux de la marque uniquement sont affichés.",
      },
      {
        heading: "Chiffres vs rapport Lightspeed",
        body: "Les totaux de l'application correspondent au rapport **Inventory Assets by Location** de Lightspeed, avec un écart résiduel de ±50 unités dû au décalage entre l'heure du snapshot (synchronisation nocturne) et l'heure à laquelle le rapport Lightspeed est consulté.\n\n**Note importante** : Lightspeed contient une localisation interne (`shop_id 0`) qui n'est pas une boutique réelle — elle n'est pas incluse dans notre calcul, exactement comme Lightspeed l'exclut de ses propres rapports de localisation.",
      },
      {
        heading: "Questions à l'assistant IA",
        body: "L'assistant IA peut interroger l'historique directement. Exemples :\n\n- *« Quels sont les stocks de la compagnie en ce moment ? »*\n- *« Quelle est la valeur du stock Brax à Saint-Sauveur aujourd'hui ? »*\n- *« Donne-moi le stock de Fan Club au 1er août »*\n\nL'assistant utilise le snapshot le plus récent disponible. Si tu demandes une date avant le 24 juillet 2026, il t'indiquera qu'aucun historique n'existe pour cette période.",
      },
    ],
  },

};

const HELP_EN = {

  quickstart: {
    title: 'Quick Start',
    icon: '🚀',
    summary: "Application overview and recommended workflow for preparing a buying season.",
    sections: [
      {
        heading: "How the application is structured",
        body: "Buying Intelligence is organized into 6 sections accessible from the navigation bar:\n\n- **📊 Budget**: automatic recommended budget calculation by brand\n- **🔄 NOS**: tracking and replenishment of permanent items\n- **📐 Size Curves**: sales distribution by size\n- **🔀 Transfers**: inter-store movement recommendations\n- **📝 Budget Planning**: entering and validating final budgets\n- **⚙️ Settings**: season configuration and calculation rules\n- **⚡ Velocity**: in-season item performance (separate page)",
      },
      {
        heading: "Recommended workflow — season preparation",
        body: "**1. Configure the target season** (Settings → Seasons)\nDefine the code, receipt dates and sales dates for the new season.\n\n**2. Analyze the recommended budget** (Budget → select the season)\nReview budgets by brand. Identify increases, decreases and alerts.\n\n**3. Review brand details**\nClick on a brand to see the breakdown by reference season, historical sell-through and sales curve.\n\n**4. Check size curves** (Size Curves section)\nValidate the order distribution by size for each brand.\n\n**5. Enter validated budgets** (Budget Planning)\nEnter final amounts by brand, drop and store.\n\n**6. Monitor during the season** (Velocity)\nTrack weekly sales pace and act quickly.",
      },
      {
        heading: "Key terms glossary",
        body: "- **Season**: a collection period identified by a code (e.g. P26 = Spring 2026, A26 = Fall 2026).\n- **Sell-through (ST)**: % of received items that were sold. ST = sales / receipts × 100.\n- **Implied receipts**: estimated ordered items = items sold + remaining stock tagged with the season.\n- **Blended base**: average of receipts and sales — anchors the budget to real demand, not just past purchases.\n- **Carryover**: unsold stock from a season that carries over to the next. Deducted from the net budget.\n- **Drop**: a planned delivery within a season (e.g. Drop 1 = January, Drop 2 = March).\n- **NOS**: Never Out of Stock — permanent items not tied to a season.\n- **Recency factor**: weight given to recent seasons in the average. A factor of 2 means the most recent season counts 2× more than the previous one.",
      },
      {
        heading: "The AI assistant",
        body: "The AI assistant button (bottom right of the screen) gives access to a chatbot that can:\n- Query the database directly (sales, inventory, sell-through)\n- Calculate budgets or size curves on demand\n- Recommend transfers\n- Answer questions about how the application works\n\nExample questions: *\"What is the ST for the Brax brand in P26?\"*, *\"Which items at Saint-Bruno should be transferred to Fan Club?\"*, *\"How does carryover work?\"*",
      },
    ],
  },

  budget: {
    title: 'Seasonal Budget',
    icon: '📊',
    summary: "Calculates the recommended purchase budget by brand for a future season, based on historical receipt and sales data from previous seasons.",
    sections: [
      {
        heading: 'How to read the table',
        body: "Each row represents a brand. The main columns:\n\n- **Implied receipts**: estimated cost of items ordered for reference seasons (sold + remaining stock tagged with the season). It's a proxy for supplier receipts without relying on purchase orders.\n- **Weighted avg ST**: average sell-through across the N reference seasons, with recent seasons weighted more heavily.\n- **Trend**: direction of receipts from one season to the next. ↑ increase > 10%, ↓ decrease > 10%, → stable.\n- **Multiplier**: factor applied according to the ST tier (e.g.: ST ≥ 65% → ×1.10).\n- **Adjusted budget**: weighted base × multiplier.\n- **Carryover**: remaining stock from the previous season that will still be available.\n- **Net budget**: adjusted budget − (carryover × deduction rate). This is the amount to order.",
      },
      {
        heading: 'Step-by-step calculation logic',
        body: "**Step 1 — Identify reference seasons**\nIf the target season is P27, we use P26, P25, P24 (the 3 previous springs). The *Number of reference seasons* setting controls this number.\n\n**Step 2 — Calculate blended base per season**\nBase = (implied receipts + projected sales) ÷ 2\nWhy the average? Receipts alone perpetuate past buying mistakes. The blended base corrects toward real demand.\n\n**Step 3 — Projection for ongoing seasons**\nIf a reference season is still in progress (e.g. P26 at 57% of its period), sales are projected to the end using historical velocity from past seasons during the same remaining window.\n\n**Step 4 — Recency-weighted average**\nWeight = recency_factor^(position). With a factor of 2 over 3 seasons: P26 weighs 4, P25 weighs 2, P24 weighs 1.\n\n**Step 5 — Apply the multiplier**\nBased on weighted average ST, the multiplier is read from the configured tiers (Settings).\n\n**Step 6 — Deduct carryover**\nNet budget = adjusted budget − (previous season remaining stock × carryover rate).",
      },
      {
        heading: 'Filters and options',
        body: "- **Target season**: the season for which the budget is being prepared.\n- **Stores**: filter by one or more stores. All stores consolidated by default.\n- **Collections / Sizes**: filter products by collection or size (Lightspeed tags).\n- **CSV Export**: export the table for external use (Excel, sharing).\n- **Click on a brand**: opens the brand detail page with complete history.",
      },
      {
        heading: "Frequently asked questions",
        body: "**Why doesn't a brand appear?**\nIts products are not tagged with the target season code in Lightspeed. Check product tags.\n\n**Why is the budget 0 or very low?**\nThe ST for reference seasons is below the lowest threshold (< 35%) → multiplier ×0.50, or the carryover exceeds the adjusted budget.\n\n**Why do the numbers differ from Lightspeed?**\nLightspeed shows 'Received Stock' as depletion (received − remaining), not as sales. Buying Intelligence uses sales lines directly.\n\n**How do I force a different budget than recommended?**\nUse the *Budget Planning* section to enter the manually validated amount.",
      },
    ],
  },

  nos: {
    title: 'NOS — Never Out of Stock',
    icon: '🔄',
    summary: "Tracking and replenishment of permanent items that must always be in stock.",
    sections: [
      {
        heading: "What is a NOS item?",
        body: "A NOS (Never Out of Stock) item is a permanent product — it is not tied to a season, it is sold year-round. Typical examples: a basic jean, a classic white shirt, recurring accessories.\n\nNOS items are identified by a specific tag in Lightspeed (e.g. \"NOS\"). This tag is configurable in Settings → Store Configuration.",
      },
      {
        heading: 'Table columns',
        body: "- **Brand / Reference**: brand and item description.\n- **Total stock**: current stock across all stores (or filtered by store).\n- **Sales N weeks**: total sales over the chosen reference period.\n- **Sales/week**: average weekly sales rate.\n- **Weeks of coverage**: at this rate, how many weeks the current stock can last.\n- **Action**: recommendation — Replenish (stock below threshold), OK (sufficient coverage).",
      },
      {
        heading: 'How to interpret and act',
        body: "**Replenishment threshold**\nIf stock covers less than N weeks (configurable), the item is flagged. The logic is: if the supplier lead time is 6 weeks, you need to order when coverage drops below 8 weeks.\n\n**Items in red**\nInsufficient stock relative to sales pace. Act quickly — contact the supplier or transfer from a better-stocked store.\n\n**Items in green**\nAdequate coverage. Monitor if sales pace accelerates.",
      },
      {
        heading: 'Available filters',
        body: "- **Stores**: view stock and sales store by store or consolidated.\n- **Collections**: filter by collection (Lightspeed tag).\n- **Reference weeks**: number of past weeks to calculate the sales rate (default: 12 weeks).",
      },
    ],
  },

  sizes: {
    title: 'Size Curves',
    icon: '📐',
    summary: "Distribution of sales by size to define the optimal split of an order and avoid stockouts or surpluses by size.",
    sections: [
      {
        heading: "What is it for",
        body: "When ordering 100 units of an item, how many in S, M, L, XL?\n\nThe Size Curves section answers this question by analyzing the historical sales distribution. If 35% of a brand's sales are in size M, we order 35 units in M out of 100.\n\nIt is also useful for detecting imbalances: if M stock is exhausted but L is full, the order curve doesn't match the sales curve.",
      },
      {
        heading: 'Reading the table',
        body: "Each row is a brand. Each column is a size. The value in each cell is the **percentage of sales** in that size over the selected period.\n\nThe **Current stock** row (if shown) displays the current stock distribution. The gap between the two rows indicates over- or under-represented sizes.\n\nExample: sales M = 38%, stock M = 20% → size M understocked, stockout risk.",
      },
      {
        heading: 'How to use for an order',
        body: "1. Select the reference season (e.g. P26 to prepare P27).\n2. Filter by brand if needed.\n3. Read the distribution row for the brand.\n4. Multiply the total budget by these percentages to get units per size.\n\nExample: budget 50 units, distribution S=15%, M=35%, L=35%, XL=15% → order 7.5/17.5/17.5/7.5 → round to 8/17/17/8.",
      },
      {
        heading: 'Available filters',
        body: "- **Season**: select the reference season.\n- **Store**: analyze distribution for a specific store.\n- **Category**: filter by product type (pants, shirt…).\n- **Gender**: filter men / women if applicable.\n- **CSV Export**: export the curve for use in a purchase order.",
      },
    ],
  },

  transfers: {
    title: 'Transfers / Actions',
    icon: '🔀',
    summary: "Automatic inter-store transfer recommendations to balance inventory, reduce tied-up capital and prevent stockouts.",
    sections: [
      {
        heading: 'How recommendations are generated',
        body: "The algorithm identifies items that simultaneously meet these two conditions:\n\n**Source store (too much stock)**:\n- High stock relative to recent sales\n- Low sales rate (weeks of coverage exceed a threshold)\n\n**Destination store (stock shortage)**:\n- Stockout or very low stock\n- Recent active sales (there is demand)\n\nThe recommended transfer is quantified in units (how many to move) and cost value.",
      },
      {
        heading: 'Priority and order of recommendations',
        body: "Recommendations are sorted by **decreasing dormant stock value** — the most costly items to hold appear first.\n\nAn item at $80 unit cost with 10 surplus units = $800 tied up. That takes priority over a $20 item with 5 units.\n\nThe value of the recommendation = cost × units to transfer.",
      },
      {
        heading: 'How to act on a recommendation',
        body: "1. **Review the recommendation**: click on the item to see the store-by-store breakdown.\n2. **Validate the logic**: does the destination store really need this item? (size suited to clientele, etc.)\n3. **Initiate the transfer** in Lightspeed POS.\n4. **Mark as processed** if applicable.\n\nNote: transferred items count neither as a receipt nor as a sale in the budget calculation for the sending store — this is intentional.",
      },
      {
        heading: 'Available filters',
        body: "- **Source store**: view items to send from a specific store.\n- **Destination store**: view items to receive at a store.\n- **Brand**: filter by supplier.\n- **Number of reference weeks**: time window for evaluating sales rate.\n- **Minimum value**: ignore recommendations below a value threshold.",
      },
    ],
  },

  plan: {
    title: 'Budget Planning',
    icon: '📝',
    summary: "Tool for entering, planning and validating purchase budgets by season, brand and drop (delivery).",
    sections: [
      {
        heading: "Overview",
        body: "The Budget section calculates a recommendation — the Budget Planning section is where the buyer enters the **validated and committed amounts**.\n\nThis is where the final confirmation happens: after reviewing the recommendation, negotiating with suppliers and adjusting, you enter the definitive budget by brand.",
      },
      {
        heading: 'The five indicators in the totals bar',
        body: "The grey bar at the top shows five figures. Here is their exact meaning:\n\n| Indicator | What it represents |\n|---|---|\n| **Recommended** | Budget calculated by the algorithm (net budget × all visible brands), plus proportional redistribution of brands you removed from the plan. This is the baseline — no human intervention. |\n| **Suggested budget** | Same calculation, **but with your manual adjustments**. If you changed the amount for a brand in the \"Suggested Budget\" column, that value is used. As long as there are no adjustments, Recommended = Suggested. |\n| **Balance** | Difference between Recommended and Suggested. Only appears if you have active adjustments. Positive = you reduced vs the algo. Negative = you increased. |\n| **Planned** | Total amounts actually entered in the drops (committed orders by brand × store). |\n| **Gap** | Planned − Suggested. Shows how much remains to confirm to reach your suggested budget. |\n\n**Recommended vs Suggested — in practice**\nIf you leave the \"Suggested Budget\" column untouched, both figures are identical. As soon as you manually modify a line (example: you raise Fradi from $8,500 to $10,000), the Suggested rises accordingly and a Balance appears showing the gap. The ↺ button to the left of the field resets the brand to its recommended amount.\n\nThe small grey value shown below some fields (e.g. `rec. $8,524`) is the original recommended amount — it stays visible so you never lose the algorithmic reference.",
      },
      {
        heading: 'The drop concept',
        body: "A **drop** is a planned delivery within a season. Some suppliers deliver in multiple shipments — Drop 1 in January, Drop 2 in March, Drop 3 in May.\n\nThis allows you to:\n- Spread the budget over time (cash flow)\n- Track deliveries separately\n- Attach different documents per delivery\n\nEach brand can have an unlimited number of drops. By default, a brand has a single drop (Drop 1).",
      },
      {
        heading: 'Entering amounts',
        body: "- Amounts are in **purchase cost** (not selling price).\n- Enter by brand × drop × store.\n- Totals by brand, by drop and overall calculate automatically.\n- An amount can be entered differently per store if purchases are managed separately.\n- Entered budgets are persisted in the database — they remain available from session to session.",
      },
      {
        heading: 'Attached documents',
        body: "For each brand × drop, it is possible to attach files:\n- Supplier spec sheets\n- Order confirmations\n- Season lookbooks\n- Price lists\n\nThese documents are stored directly in the application and accessible by the whole team.",
      },
      {
        heading: 'Tracking and export',
        body: "- **Recommended vs entered comparison**: the algorithm's recommended budget is displayed alongside the entered budget for easy validation.\n- **Export**: the complete budget can be exported as CSV for integration into an accounting system or sharing with a supplier.",
      },
    ],
  },

  params: {
    title: 'Settings',
    icon: '⚙️',
    summary: "Configuration of seasons, multiplier tiers and budget calculation parameters.",
    sections: [
      {
        heading: 'Season configuration',
        body: "Each season is defined by:\n- **Code**: short identifier (e.g. \"p26\").\n- **Label**: displayed name (e.g. \"Spring 2026\").\n- **Lightspeed tag**: the tag applied to products in Lightspeed to associate them with this season (e.g. \"p26\"). Must match exactly the tags used in Lightspeed.\n- **Receipt start**: date from which season receipts are counted.\n- **Sales start**: beginning of the sales window.\n- **Sales end**: end of the sales window.\n\nThese dates define the calculation windows. A misconfigured season will produce incorrect budgets.",
      },
      {
        heading: 'Multiplier tiers',
        body: "Each tier defines the **ST → multiplier** rule:\n\n| Avg ST | Multiplier | Interpretation |\n|--------|-----------|----------------|\n| ≥ 80% | ×1.25 | Increase |\n| ≥ 65% | ×1.10 | Slight increase |\n| ≥ 50% | ×1.00 | Maintain |\n| ≥ 35% | ×0.80 | Reduce |\n| < 35% | ×0.50 | Cut |\n\nThese tiers are fully editable. Thresholds and multipliers can be adjusted according to your buying strategy.",
      },
      {
        heading: 'Calculation parameters',
        body: "**Number of reference seasons** (default: 3)\nHow many past seasons enter the calculation. A higher number produces a more stable average but less reactive to recent trends.\n\n**Recency factor** (default: 2.0)\nWeight given to recent seasons. With 3 seasons and a factor of 2:\n- Season N-1 → weight 4 (2²)\n- Season N-2 → weight 2 (2¹)\n- Season N-3 → weight 1 (2⁰)\nTotal = 7. The most recent season accounts for 57% of the budget.\n\n**Carryover rate** (default: 50%)\nPercentage of remaining stock deducted from the net budget. A rate of 50% means that if $10,000 of stock from a season remains unsold, $5,000 is deducted from the next budget.\n\n**Per-store rate**\nOption to define a different carryover rate per store — useful if some stores have better sell-through capacity.",
      },
      {
        heading: 'Store configuration (onboarding)',
        body: "The Configuration page (⚙ in the nav) allows you to define:\n- Store / tenant name\n- The field used for product type (category, tag or description)\n- Enabling and values of the gender filter (men/women)\n- The tag identifying NOS items\n- Lightspeed connection credentials",
      },
    ],
  },

  velocity: {
    title: 'Velocity',
    icon: '⚡',
    summary: "In-season item performance analysis — sell-through by week, full-price percentage and action recommendations.",
    sections: [
      {
        heading: 'Weekly metrics',
        body: "Velocity measures the sales rate relative to the opening stock (items received at the start of the season).\n\n- **ST W4**: % of opening stock sold after 4 weeks.\n- **ST W7**: % sold after 7 weeks.\n- **ST W10**: % sold after 10 weeks.\n- **ST W14**: % sold after 14 weeks.\n- **Final ST**: total % sold since the start of the season.\n- **% full price**: share of sales made without a discount ≥ 10%. A high % means customers buy without waiting for sales.",
      },
      {
        heading: 'Rating A → D',
        body: "Each item receives a rating based on the combination of ST and % full price:\n\n- **A (green)**: excellent ST and full price — top performer, may justify replenishment.\n- **B (blue)**: adequate performance — monitor.\n- **C (orange)**: low ST or full price — action recommended in the coming weeks.\n- **D (red)**: both metrics low — urgent clearance needed.",
      },
      {
        heading: "Recommended actions",
        body: "Based on sales rate, remaining stock and season progress:\n\n- **Replenish**: strong demand, stock will run out before end of season.\n- **Monitor**: normal performance, nothing to do now.\n- **Promote**: sales below expected pace — consider featuring or a light markdown.\n- **Mark down**: high stock, season advanced — trigger markdowns to clear.\n- **Urgent markdown**: very high stock, season near end — act immediately.",
      },
      {
        heading: 'Available views',
        body: "**By brand**\nAggregates all items for a brand. Gives a macro view of the full collection's ST.\n\n**By matrix**\nA matrix is a model available in multiple sizes/colours. This view shows each model's performance individually (e.g. pant A45118 in 5 sizes).\n\n**By item**\nUnit detail — one row per variant (size + colour). Shows exactly which colourways or sizes are performing and which are stalling.",
      },
      {
        heading: 'Typical use cases',
        body: "**Weekly review**: go through all D and C items — decide on the week's actions.\n\n**Markdown preparation**: list all items with ST < 50% and stock > 0 — build the markdown list.\n\n**Replenishment**: identify A items with stock < 2 weeks of coverage — place a quick order.\n\n**End-of-season review**: at season end, analyze ST curves to adjust budgets for the next season.",
      },
    ],
  },

  accounting: {
    title: 'Supplier Accounting',
    icon: '💰',
    summary: "Decision support for discount vs net terms for each supplier, based on the annualized return on the discount and cost of capital.",
    sections: [
      {
        heading: 'The discount vs net terms decision',
        body: "Most suppliers offer an **early payment discount**: for example \"2/10 n/60\" means 2% off if paid in 10 days rather than 60 days.\n\nThe question is: is it better to take this discount (pay early and save 2%) or keep the money 50 more days (and invest or use it elsewhere)?\n\nThe answer depends on the **annualized return** of the discount compared to the company's **cost of capital**.",
      },
      {
        heading: 'Annualized return formula',
        body: "**Formula:**\n\n`Return = (discount% ÷ (1 − discount%)) × (365 ÷ (net_days − discount_days))`\n\n**Example: 2/10 n/60**\n- Discount = 2%\n- Days gained = 60 − 10 = 50 days\n- Return = (2 ÷ 98) × (365 ÷ 50) = **14.9% per year**\n\nIf cost of capital is 8%/year: **take the discount** (14.9% > 8%).\nIf cost of capital is 20%/year: **net terms** (14.9% < 20%).\n\nNote: dividing by `(1 − discount%)` reflects that the discount is calculated on the gross amount — without this correction, the return would be slightly underestimated.",
      },
      {
        heading: 'Velocity and financing window',
        body: "**Velocity** (days to sell through stock at the last 90 days' pace) is used to qualify the recommendation:\n\n- If `net_days > velocity` → the supplier finances the sale (you sell before having to pay). This is the ideal situation.\n- If `net_days < velocity` → you must pay before you've sold. The discount pulls cash out even earlier from slow-moving inventory — a ⚠ warning is shown.\n\nVelocity does not reverse the recommendation (if return > cost of capital, taking the discount remains profitable) but it flags a cash flow constraint to watch.",
      },
      {
        heading: 'Entering supplier terms',
        body: "Click the **Supplier Terms** column of a brand to open the entry panel. Accepted formats:\n\n- `2/10 n/60` — 2% discount if paid in 10 days, net 60 days\n- `2% 10 days net 60` — same thing, long format\n- `n/30` or `net 30` — no discount, 30-day terms\n\nA **margin override** can be entered if the margin calculated from sales doesn't reflect reality (e.g. contractually negotiated margin).",
      },
      {
        heading: 'Cost of capital',
        body: "The cost of capital is the central parameter of the comparison. It represents what money is worth to the company — either the borrowing rate if in overdraft, or the alternative return on cash.\n\n**Default: 8%/year.** Adjust in the page header according to the actual financial situation. The value is saved and applies to all brands.",
      },
    ],
  },

  'inv-history': {
    title: 'Stock History',
    icon: '📦',
    summary: "Tracking stock changes over time — units, cost value and retail value — by store and by brand.",
    sections: [
      {
        heading: "How it works",
        body: "Each night, during the Lightspeed sync, a **snapshot** (photo) of inventory is taken and recorded. This snapshot captures exactly the number of units and the value of each item in each store at that precise moment.\n\nHistory begins on the date of the **first snapshot** (July 24, 2026). It is not possible to view stock before this date — the data does not exist retroactively.\n\nSnapshots cover a rolling window of **400 days** in daily detail. Beyond that, data is consolidated into monthly averages and kept indefinitely.",
      },
      {
        heading: "The three metrics",
        body: "| Metric | What it measures |\n|---|---|\n| **Units in stock** | Total number of items physically in store on the selected date. |\n| **Cost value** | Units × unit purchase cost (price paid to the supplier). Useful for evaluating capital tied up. |\n| **Retail value** | Units × selling price. Indicates potential revenue if everything were sold at full price. |\n\nValue is calculated at the unit cost **on the day of the snapshot** — it does not change if prices are later modified. It is a fixed snapshot, not an accounting valuation.",
      },
      {
        heading: "Available filters",
        body: "- **Date**: select any day since the first snapshot. KPIs and the breakdown table update.\n- **Store**: filter to a single store. By default all stores are included.\n- **Brand**: filter to a specific brand (e.g. \"Brax\"). Combinable with the store filter.\n- **Metric**: choose what the chart displays (units, cost value or retail value).\n- **Granularity**: Daily (one point per day) or Monthly (average of days in the month).",
      },
      {
        heading: "The breakdown table",
        body: "Without a store filter: the table shows the **breakdown by store**. Clicking a store opens the **by brand** detail for that store (← button to go back).\n\nWith a store filter: the table shows directly the **by brand** breakdown in that store.\n\nWith a brand filter: only that brand's totals are displayed.",
      },
      {
        heading: "Numbers vs Lightspeed report",
        body: "The application totals match the **Inventory Assets by Location** report in Lightspeed, with a residual variance of ±50 units due to the lag between the snapshot time (nightly sync) and when the Lightspeed report is viewed.\n\n**Important note**: Lightspeed contains an internal location (`shop_id 0`) that is not a real store — it is not included in our calculation, exactly as Lightspeed excludes it from its own location reports.",
      },
      {
        heading: "Questions for the AI assistant",
        body: "The AI assistant can query the history directly. Examples:\n\n- *\"What is the company's current inventory?\"*\n- *\"What is the value of Brax stock at Saint-Sauveur today?\"*\n- *\"Give me Fan Club's inventory as of August 1st\"*\n\nThe assistant uses the most recent available snapshot. If you ask about a date before July 24, 2026, it will tell you no history exists for that period.",
      },
    ],
  },

};

module.exports = { fr: HELP, en: HELP_EN };
