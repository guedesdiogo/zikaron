// Function words a search leaves out, in Portuguese and English: articles, prepositions,
// conjunctions, pronouns, and the forms of "ser", "estar", "ter", "haver", "be", "have" and "do".
// They are folded as queries are: lowercase, without diacritics. A general list, as ai-memory's
// `fts_query.rs` keeps one; content words stay, even common ones.

const PORTUGUESE = `
a o as os um uma uns umas ao aos à às
de da das do dos em na nas no nos num numa nuns numas dum duma
por pela pelas pelo pelos para pra pras pro pros com sem sob sobre entre ate apos desde contra perante
e ou mas nem que se como quando onde porque pois ja tambem so muito muita muitos muitas mais menos
bem ainda sempre nunca nao sim entao la aqui ali
eu tu ele ela nos vos eles elas voce voces me te lhe lhes mim ti comigo contigo conosco consigo
meu minha meus minhas teu tua teus tuas seu sua seus suas nosso nossa nossos nossas
dele dela deles delas
este esta estes estas esse essa esses essas aquele aquela aqueles aquelas isto isso aquilo
qual quais quem quanto quanta quantos quantas cujo cuja
ser sou es e somos sao era eram fui foi fomos foram seja sejam sera serao seria
estar estou esta estamos estao estava estavam esteve estiveram esteja
ter tenho tem temos tinha tinham teve tiveram tenha tera teria
haver ha havia houve
`;

const ENGLISH = `
a an the of in on at to for from by with about as into onto over under after before between
and or but nor not no so if then than
i me my mine you your yours he him his she her hers it its we us our ours they them their theirs
this that these those what which who whom whose where when why how there here
is are was were be been being am do does did done have has had having
can could would should will shall may might must just very too also
`;

const MONTHS_AND_DAYS = `
janeiro fevereiro marco abril maio junho julho agosto setembro outubro novembro dezembro
jan fev mar abr mai jun jul ago set out nov dez
segunda terca quarta quinta sexta sabado domingo feira
january february march april may june july august september october november december
monday tuesday wednesday thursday friday saturday sunday
`;

const words = (list: string) => new Set(list.split(/\s+/).filter((word) => word !== ""));

export const STOPWORDS: ReadonlySet<string> = new Set([...words(PORTUGUESE), ...words(ENGLISH)]);

/** Names of months and weekdays: left out of a question whose date was already resolved. */
export const DATE_WORDS: ReadonlySet<string> = words(MONTHS_AND_DAYS);
