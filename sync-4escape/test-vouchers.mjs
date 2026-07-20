// Test unitaire : les codes de reduction (Vouchers/Remises appliques) ne doivent
// JAMAIS compter dans le CA encaisse. Cas reconstitues depuis les captures reelles.
import fs from 'node:fs';
import { analyseJournal } from './scrape.mjs';

const H = ['Code journal','Type écriture','N° Compte général','N° Facture','Date de facture','N° Compte tiers','Société','Contact','Catégorie de produit','Session de jeu','Produit','Prix appliqué','Quantité','Débit','Crédit','Montant','Taxes appliquées','Référence de commande',"Date d'évènement",'Date de création','Numéro série caisse','Vendeur'];
const D = '20/07/2026';
const row = (cpt, cat, sess, prod, qte, deb, cred, tax) =>
  ['VENTES','1',cpt,'F',D,'4111','','CLIENT',cat,sess,prod,'',qte,deb,cred,String(Math.max(+String(deb).replace(',','.'),+String(cred).replace(',','.'))).replace('.',','),tax,'F',D,D,'',''];

const rows = [H,
  // P1587 HELSTROFFER : session 130,91 payee 100% en CARTE CADEAU BUZZ -> client 0
  row('70','Room','BUZZ - 8P - 18:00','Quiz 8 joueurs','8','0','130,91','10'),
  row('709','Vouchers/Remises appliqués','','WVM-1U5-QJH - CARTE CADEAU BUZZ','1','130,91','0','10'),
  row('44571','TVA','','TVA 10%','','0','0','10'),
  row('4111','','','','','0','0',''),
  // P1679 COUSIN : session 130,91 - code TRIP 13,09 -> client 129,60
  row('70','Room','ROOM - 6P - 16:30','Room 6 joueurs','6','0','130,91','10'),
  row('709','Vouchers/Remises appliqués','','TRIP - TRIP','1','13,09','0','10'),
  row('44571','TVA','','TVA 10%','','0','11,78','10'),
  row('4111','','','','','129,6','0',''),
  // P1645 BROSTIN : 114,55 - MARIAGE 19,09 -> client 105
  row('70','Room','BUZZ - 6P - 16:15','Quiz 6 joueurs','6','0','114,55','10'),
  row('709','Vouchers/Remises appliqués','','MARIAGE - EVJF EVG','1','19,09','0','10'),
  row('44571','TVA','','TVA 10%','','0','9,54','10'),
  row('4111','','','','','105','0',''),
  // P1689 SAGAN : 120,91 - 2 codes Buzz 17,27 -> client 95
  row('70','Room','BUZZ - 7P - 18:00','Quiz 7 joueurs','7','0','120,91','10'),
  row('709','Vouchers/Remises appliqués','','BUZZMMC-LPM - Buzz Oct.2025','1','17,27','0','10'),
  row('709','Vouchers/Remises appliqués','','BUZZCB6-RD2-28U - Buzz 10/23','1','17,27','0','10'),
  row('44571','TVA','','TVA 10%','','0','8,63','10'),
  row('4111','','','','','95','0',''),
  // P1617 VIEL : session simple sans code -> client 74
  row('70','Room','ROOM - 2P - 13:15','Adulte - 2 joueurs','2','0','67,27','10'),
  row('44571','TVA','','TVA 10%','','0','6,73','10'),
  row('4111','','','','','74','0',''),
  // Cas blindage : un code range sur compte 70 (pas 709) mais categorie Vouchers
  row('70','Room','ROOM - 3P - 11:00','Room 3 joueurs','3','0','76,36','10'),
  row('70','Vouchers/Remises appliqués','','CODE-TEST - sur compte 70','1','9,09','0','10'),
  row('44571','TVA','','TVA 10%','','0','6,73','10'),
  row('4111','','','','','74','0',''),
];

const csv = '﻿' + rows.map((r) => r.map((c) => '"' + String(c) + '"').join(';')).join('\r\n');
fs.writeFileSync('debug/test-vouchers.csv', csv, 'utf8');

const r = analyseJournal('debug/test-vouchers.csv', D, 'ventes');
const expTTC = 0 + 129.6 + 105 + 95 + 74 + 74;   // = 477,60 : uniquement l'argent reellement paye
const ok1 = Math.abs(r.ttc - expTTC) < 0.01;
const ok2 = Math.abs((r.ht + r.tva) - r.ttc) < 0.05;
const ok3 = r.sessions === 6;
console.log(`CA TTC calcule   = ${r.ttc} € (attendu ${expTTC}) ${ok1 ? 'PASS' : 'FAIL'}`);
console.log(`HT+TVA = TTC     : ${r.ht} + ${r.tva} = ${Math.round((r.ht + r.tva) * 100) / 100} ${ok2 ? 'PASS' : 'FAIL'}`);
console.log(`Sessions vendues = ${r.sessions} (attendu 6) ${ok3 ? 'PASS' : 'FAIL'}`);
console.log(`Remises (codes)  = ${r.remises} € — jamais comptees dans le CA`);
fs.unlinkSync('debug/test-vouchers.csv');
process.exit(ok1 && ok2 && ok3 ? 0 : 1);
