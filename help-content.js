'use strict';

const HELP = {
  budget: {
    title: 'Budget saisonnier',
    icon: '📊',
    summary: "Calcule le budget d'achat recommandé par marque pour une saison future, à partir des historiques de réceptions et de ventes.",
    sections: [
      {
        heading: 'Comment lire le tableau',
        body: "Chaque ligne représente une marque. Les colonnes clés :\n- **Réceptions impliquées** : coût estimé des articles reçus (vendus + stock restant taggé avec la saison).\n- **ST moyen pondéré** : sell-through moyen sur les saisons de référence, pondéré par récence.\n- **Tendance** : direction des réceptions entre les saisons (↑ hausse, ↓ baisse, → stable).\n- **Multiplicateur** : facteur appliqué selon le palier de ST (ex : ST ≥ 65 % → ×1.10).\n- **Budget ajusté** : base × multiplicateur.\n- **Budget net** : budget ajusté − déduction carryover (stock restant × taux de déduction).",
      },
      {
        heading: 'Logique de calcul',
        body: "1. On identifie les N saisons précédentes du même type (P→P, A→A).\n2. Pour chaque saison de référence, on calcule une base blendée = (réceptions + ventes projetées) ÷ 2.\n3. Les saisons récentes pèsent plus lourd (facteur de récence configurable).\n4. On applique le multiplicateur selon le ST, puis on déduit le carryover.",
      },
      {
        heading: 'Filtres disponibles',
        body: "Saison cible, boutiques (une ou plusieurs), collections, tailles. Cliquer sur une marque ouvre sa page détail.",
      },
    ],
  },

  nos: {
    title: 'NOS — Never Out of Stock',
    icon: '🔄',
    summary: "Gestion des articles permanents qui doivent toujours être disponibles en stock.",
    sections: [
      {
        heading: "À quoi ça sert",
        body: "Les articles NOS (Never Out of Stock) sont des produits permanents — ils ne sont pas liés à une saison. Cette section montre, pour chaque article NOS :\n- Le stock actuel par boutique.\n- Les ventes sur les N dernières semaines.\n- Le taux de vente hebdomadaire moyen.\n- Une recommandation de réapprovisionnement si le stock est bas.",
      },
      {
        heading: 'Identification des produits NOS',
        body: 'Les produits NOS sont identifiés par un tag configurable dans les paramètres (ex. "NOS"). Tout article portant ce tag est inclus dans cette vue.',
      },
      {
        heading: 'Filtres disponibles',
        body: "Boutiques, collections, nombre de semaines de référence pour le calcul des ventes.",
      },
    ],
  },

  sizes: {
    title: 'Courbes tailles',
    icon: '📐',
    summary: "Distribution des ventes par taille pour définir la répartition idéale d'une commande.",
    sections: [
      {
        heading: "À quoi ça sert",
        body: "Affiche, pour chaque marque et saison, quelle proportion des ventes s'est faite par taille (S, M, L, XL…). Cela permet de décider combien commander dans chaque taille lors de la prochaine saison.",
      },
      {
        heading: 'Lecture du tableau',
        body: "Chaque colonne est une taille. Le pourcentage indique la part de cette taille dans le total des ventes de la marque. La comparaison avec la distribution du stock en main permet de voir si les tailles sont bien équilibrées.",
      },
      {
        heading: 'Filtres disponibles',
        body: "Saison, boutique, catégorie, genre. Exporter en CSV pour utiliser dans un bon de commande.",
      },
    ],
  },

  transfers: {
    title: 'Transferts / Actions',
    icon: '🔀',
    summary: "Recommandations de transferts inter-boutiques pour équilibrer les stocks et réduire les immobilisations.",
    sections: [
      {
        heading: 'Logique des recommandations',
        body: "L'outil identifie les articles avec un surplus dans une boutique (stock élevé, faibles ventes récentes) et une demande dans une autre boutique (rupture ou stock bas, bonnes ventes). Il propose un transfert chiffré en unités et en valeur.",
      },
      {
        heading: 'Priorité',
        body: "Les recommandations sont classées par valeur du stock dormant décroissante. Les articles les plus coûteux à immobiliser apparaissent en premier.",
      },
      {
        heading: 'Filtres disponibles',
        body: "Boutique source, marque, nombre de semaines de référence pour évaluer les ventes.",
      },
    ],
  },

  plan: {
    title: 'Création de budget',
    icon: '📝',
    summary: "Saisie et validation des budgets d'achat par saison, marque et drop (livraison).",
    sections: [
      {
        heading: 'Concept de drop',
        body: "Un drop est une livraison planifiée au sein d'une saison. Chaque marque peut avoir plusieurs drops (ex. Drop 1 en janvier, Drop 2 en mars). Cela permet de répartir le budget dans le temps.",
      },
      {
        heading: 'Saisie des montants',
        body: "Entrer le montant en coût d'achat pour chaque marque × drop × boutique. Les totaux se calculent automatiquement. Les budgets saisis servent de référence lors des achats réels.",
      },
      {
        heading: 'Documents',
        body: "Il est possible d'attacher des fichiers (fiches fournisseur, confirmations) à chaque drop.",
      },
    ],
  },

  params: {
    title: 'Paramètres',
    icon: '⚙️',
    summary: "Configuration des saisons, des règles de calcul et des paliers de multiplicateurs.",
    sections: [
      {
        heading: 'Configuration des saisons',
        body: 'Chaque saison a un code (ex. "p26"), une étiquette, un tag Lightspeed (ex. "p26"), une date de début de réception et une période de vente. Ces dates servent à délimiter les fenêtres de calcul.',
      },
      {
        heading: 'Paliers de multiplicateurs',
        body: "Définissent la règle ST → multiplicateur :\n- ST ≥ 80 % → ×1.25 (Augmenter)\n- ST ≥ 65 % → ×1.10 (Légère hausse)\n- ST ≥ 50 % → ×1.00 (Reconduire)\n- ST ≥ 35 % → ×0.80 (Réduire)\n- ST < 35 % → ×0.50 (Couper)\nCes paliers sont modifiables.",
      },
      {
        heading: 'Paramètres de calcul',
        body: "- **Nb saisons de référence** : combien de saisons passées utiliser (défaut : 3).\n- **Facteur de récence** : poids des saisons récentes vs anciennes (défaut : 2.0 — la saison la plus récente pèse 4× la plus ancienne sur 3 saisons).\n- **Taux carryover** : % du stock restant déduit du budget net (défaut : 50 %).\n- **Taux par boutique** : possibilité de définir un taux carryover différent par boutique.",
      },
    ],
  },

  velocity: {
    title: 'Vélocité',
    icon: '⚡',
    summary: "Analyse de performance des articles en cours de saison — sell-through par semaine et recommandations d'action.",
    sections: [
      {
        heading: 'Métriques clés',
        body: "- **ST S4 / S7 / S10 / S14** : sell-through cumulé à 4, 7, 10 et 14 semaines.\n- **ST global** : sell-through total depuis le début de la saison.\n- **% plein tarif** : part des ventes faites sans remise significative.\n- **Rating** : A (excellent) → D (très faible), basé sur la combinaison ST et plein tarif.",
      },
      {
        heading: "Action recommandée",
        body: "Selon le rythme de vente et le stock restant, l'outil suggère une action :\n- **Réapprovisionner** : la demande dépasse le stock prévu.\n- **Monitorer** : performance correcte, surveiller.\n- **Solder / Promouvoir** : ventes lentes, écoulement recommandé.\n- **Solde urgent** : stock élevé, saison avancée.",
      },
      {
        heading: 'Vues disponibles',
        body: "**Par marque** : vue agrégée de toutes les marques. **Par matrice** : vue par modèle (ex. un pantalon en 5 tailles). **Par article** : détail unité par unité avec taille et description.",
      },
    ],
  },
};

module.exports = HELP;
