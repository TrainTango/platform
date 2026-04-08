export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400');
  return res.status(200).json({ locations: STATIONS });
}

const STATIONS = [
  {"description":"Aberdeen","shortCodes":["ABD"]},
  {"description":"Basingstoke","shortCodes":["BSK"]},
  {"description":"Bath Spa","shortCodes":["BTH"]},
  {"description":"Birmingham New Street","shortCodes":["BHM"]},
  {"description":"Brighton","shortCodes":["BTN"]},
  {"description":"Bristol Temple Meads","shortCodes":["BRI"]},
  {"description":"Cambridge","shortCodes":["CBG"]},
  {"description":"Cardiff Central","shortCodes":["CDF"]},
  {"description":"Clapham Junction","shortCodes":["CLJ"]},
  {"description":"Derby","shortCodes":["DBY"]},
  {"description":"East Croydon","shortCodes":["ECR"]},
  {"description":"Edinburgh Waverley","shortCodes":["EDB"]},
  {"description":"Exeter St Davids","shortCodes":["EXD"]},
  {"description":"Gatwick Airport","shortCodes":["GTW"]},
  {"description":"Glasgow Central","shortCodes":["GLC"]},
  {"description":"Glasgow Queen Street","shortCodes":["GLQ"]},
  {"description":"Guildford","shortCodes":["GLD"]},
  {"description":"Haywards Heath","shortCodes":["HHE"]},
  {"description":"Leeds","shortCodes":["LDS"]},
  {"description":"Leicester","shortCodes":["LEI"]},
  {"description":"Liverpool Lime Street","shortCodes":["LIV"]},
  {"description":"London Blackfriars","shortCodes":["BFR"]},
  {"description":"London Bridge","shortCodes":["LBG"]},
  {"description":"London Cannon Street","shortCodes":["CST"]},
  {"description":"London Charing Cross","shortCodes":["CHX"]},
  {"description":"London Euston","shortCodes":["EUS"]},
  {"description":"London Fenchurch Street","shortCodes":["FST"]},
  {"description":"London Kings Cross","shortCodes":["KGX"]},
  {"description":"London Liverpool Street","shortCodes":["LST"]},
  {"description":"London Marylebone","shortCodes":["MYB"]},
  {"description":"London Paddington","shortCodes":["PAD"]},
  {"description":"London S
