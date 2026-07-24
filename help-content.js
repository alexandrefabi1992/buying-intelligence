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

module.exports = HELP;
