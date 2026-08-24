# Verrouiller la base Firebase — mode d'emploi

Firebase a envoyé une alerte le **24/08/2026** : la base `gamedoor-objectives-default-rtdb`
est **ouverte en lecture ET en écriture, sans aucune authentification**.

Vérifié le jour même : depuis n'importe quel ordinateur, sans mot de passe, avec la seule
URL de la base (qui est écrite en clair dans `index.html`, dans un dépôt GitHub **public**),
on peut lire les **2164 journées de chiffre d'affaires depuis 2020** — et les effacer.

---

## Comment appliquer

Tout est automatisé dans [`apply-security.mjs`](apply-security.mjs). Une seule chose ne peut
pas l'être : ouvrir une session Google, qui exige un vrai terminal.

```sh
firebase login --reauth        # choisir le compte propriétaire de gamedoor-objectives
node apply-security.mjs
```

Le script enchaîne, dans cet ordre — l'ordre compte :

1. **Active l'authentification anonyme.** Le dashboard ([index.html:644](index.html#L644)) et le
   robot ([sync-4escape/scrape.mjs:292](sync-4escape/scrape.mjs#L292)) l'appellent tous les deux,
   mais elle **n'est pas activée** sur le projet (`CONFIGURATION_NOT_FOUND`) : leur appel échoue
   en silence et ils passent *sans* identité. Ça ne marche aujourd'hui que parce que la base est
   grande ouverte.
2. **Vérifie qu'un client obtient bien un jeton anonyme** — et s'arrête là si ce n'est pas le cas.
   Publier les règles avant que ce point soit acquis mettrait l'écran de la salle de pause en
   « Hors ligne » et ferait échouer la synchro de la nuit.
3. **Publie** [`database.rules.json`](database.rules.json).
4. **Teste le résultat** : lecture et écriture refusées sans jeton, lecture et écriture d'une
   journée acceptées avec un jeton anonyme, effacement global refusé, 2164 journées toujours là.

En cas de doute à tout moment :

```sh
cd sync-4escape && node check-firebase-rules.mjs --full
```

### Si tu préfères la console

Firebase → **Authentication** → **Sign-in method** → **Anonyme** → *Activer*.
Puis **Realtime Database** → **Règles** → coller `database.rules.json` → *Publier*.
Dans cet ordre, jamais l'inverse.

---

## Ce que font les règles

| Chemin | Lecture | Écriture |
|---|---|---|
| racine (hors `/state`) | interdite | interdite |
| `/state` (tout) | authentifié | — |
| `/state/config`, `/roster`, `/ventesCo` | authentifié | authentifié |
| `/state/autoMeta` (mémos du robot) | authentifié | authentifié |
| `/state/entries` (le nœud entier) | authentifié | **interdite** |
| `/state/entries/auto-AAAA-MM-JJ` | authentifié | authentifié, format validé |

Deux protections en plus du simple « il faut être connecté » :

- **l'historique ne peut plus être effacé ni remplacé en un seul appel** — seules les
  écritures jour par jour passent. C'est exactement l'accident qui s'est produit pendant
  l'audit du 24/08/2026 (un `PUT` sur `/state/entries` a remplacé les 2164 journées ;
  restaurées depuis 4escape dans la foulée) ;
- **une journée doit ressembler à une journée** : clé `auto-AAAA-MM-JJ`, champs `date`,
  `ca`, `sessions` présents et dans des bornes plausibles.

### Conséquence sur le dashboard

Le bouton **« ⌫ Tout effacer »** de l'écran Réglages a été retiré le 24/08/2026 : il faisait
précisément le `remove()` global que les règles interdisent désormais. Rien d'autre ne change
dans l'usage quotidien.

Le bouton **« ↺ Nouveau mois »** ([index.html:530](index.html#L530)), lui, fonctionne toujours —
les règles autorisent la suppression journée par journée. Depuis que la saisie est entièrement
automatique, il n'a plus vraiment d'usage et il efface les données du mois en cours sans que le
robot les réécrive (l'anti-doublon `lastSync` ne retraite que la veille). À retirer aussi, à
décider.

## Limite connue

L'authentification anonyme est ouverte : n'importe qui peut demander un jeton au projet.
Ces règles arrêtent donc les robots qui scannent les bases ouvertes et les accès à l'URL nue,
mais pas quelqu'un de déterminé qui reprendrait la clé web dans `index.html`.

Pour aller plus loin (non fait, à décider) : créer dans Firebase Authentication un compte
e-mail/mot de passe dédié au robot, le faire se connecter avec (`signInWithPassword` au lieu
de `signUp` anonyme dans `scrape.mjs`), et réserver l'écriture de `/state/entries` et
`/state/autoMeta` à cet identifiant précis (`auth.uid === '...'`). Le dashboard, lui, resterait
en anonyme et deviendrait **lecture seule** — ce qui correspond à ce qu'il est devenu depuis
la refonte du 21/07/2026 (plus de saisie manuelle), à l'exception des réglages d'objectifs.
