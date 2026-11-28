import {expect,test,type Page,type Locator} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {collectionPdf} from './helpers/collectionPdf';

function pdf(name:string,pages:string[][]){return {name,mimeType:'application/pdf',buffer:collectionPdf(pages)};}
async function workspace(page:Page,fixtures:ReturnType<typeof pdf>[]){
  await page.goto('/?view=chat');
  await page.getByText('Search an independent PDF collection (up to six documents)',{exact:true}).click();
  const root=page.getByRole('region',{name:'Independent PDF collection',exact:true});
  await root.getByLabel('Attach collection PDFs').setInputFiles(fixtures);
  await expect(root.getByLabel('Collection processing budget')).toContainText(fixtures.length+' / 6');
  await expect(root.getByLabel('Collection attachment result')).toBeVisible();
  await expect(root.getByText(/Indexing collection PDF/)).toHaveCount(0);
  return root;
}
async function expand(root:Locator,name:string){
  const panel=root.getByRole('group',{name,exact:true});
  await panel.locator('summary').first().click();
  return panel;
}
async function ask(root:Locator,question:string){
  await root.getByLabel('Collection question',{exact:true}).fill(question);
  await root.getByRole('button',{name:'Ask collection',exact:true}).click();
  return root.getByLabel('Collection results',{exact:true});
}
async function downloadJson(page:Page,button:Locator){
  const waiting=page.waitForEvent('download');
  await button.click();
  const result=await waiting,path=await result.path();
  if(!path)throw Error('No local test download');
  return {name:result.suggestedFilename(),text:await readFile(path,'utf8')};
}
function jsonFile(text:string){return {name:'report.json',mimeType:'application/json',buffer:Buffer.from(text,'utf8')};}

test('guided composer explicitly builds two independent physical scopes without submitting',async({page})=>{
  const root=await workspace(page,[
    pdf('a.pdf',[['Application fee: INR 500'],['Eligibility: Class 12']]),
    pdf('b.pdf',[['Application fee: INR 350']]),
  ]);
  const guide=await expand(root,'Guided collection question composer');
  await guide.getByLabel('Notice topic',{exact:true}).selectOption('application_fee');
  await guide.getByRole('button',{name:'Add selected notice topic'}).click();
  await guide.getByLabel('Physical page for part 1').fill('1');
  await guide.getByLabel('Notice topic',{exact:true}).selectOption('eligibility');
  await guide.getByRole('button',{name:'Add selected notice topic'}).click();
  await guide.getByLabel('Physical page for part 2').fill('2');
  const preview=guide.getByRole('region',{name:'Guided question draft preview'});
  await expect(preview).toContainText('Application fee on page 1? Eligibility on page 2?');
  await expect(preview).toContainText('4 independent searches');
  await root.getByLabel('Collection question',{exact:true}).fill('Existing unsent question');
  const use=preview.getByRole('button',{name:'Use guided question draft'});
  await expect(use).toBeDisabled();
  await preview.getByLabel('Replace the current unsent question and its scope with this guided draft.').check();
  await use.click();
  await expect(root.getByLabel('Collection question',{exact:true})).toHaveValue('Application fee on page 1? Eligibility on page 2?');
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
  await root.getByRole('button',{name:'Ask collection',exact:true}).click();
  const results=root.getByLabel('Collection results',{exact:true});
  await expect(results.getByRole('region',{name:'Collection result: Document 1: a.pdf'}).locator('blockquote'))
    .toHaveText(['Application fee: INR 500','Eligibility: Class 12']);
  await expect(results.getByRole('region',{name:'Collection result: Document 2: b.pdf'}).locator('blockquote'))
    .toHaveText('Application fee: INR 350');
  await expect(results).toContainText('This physical page does not exist');
});

test('focused question brief requires export consent and verifies unchanged exact bytes',async({page})=>{
  const api:string[]=[];
  await page.route('**/api/**',route=>{api.push(route.request().url());return route.abort();});
  const root=await workspace(page,[
    pdf('private-a.pdf',[['Application fee: INR 500'],['Eligibility: Class 12']]),
    pdf('private-b.pdf',[['Application fee: INR 350']]),
  ]);
  await ask(root,'Application fee? Eligibility on page 2?');
  const panel=await expand(root,'Question evidence brief');
  await panel.getByLabel('Question part for brief').selectOption('1');
  await panel.getByRole('button',{name:'Prepare question evidence brief'}).click();
  const button=panel.getByRole('button',{name:'Export verifiable question brief'});
  await expect(button).toBeDisabled();
  await expect(panel).toContainText('Eligibility: Class 12');
  await expect(panel).toContainText('The requested physical page is not present.');
  const consent=panel.getByLabel('I approve exporting this private question evidence brief.');
  await consent.check();
  const saved=await downloadJson(page,button),value=JSON.parse(saved.text);
  expect(saved.name).toBe('noticebridge-question-brief.json');
  expect(value).toMatchObject({part_index:1,physical_page:2,authority_verified:false});
  expect(value.sources[0].citations[0].text).toBe('Eligibility: Class 12');
  expect(value.sources[1].outcome).toBe('no_evidence');
  expect(saved.text).not.toContain('private-a.pdf');
  expect(saved.text).not.toContain('INR 500');
  await expect(button).toBeDisabled();
  const input=panel.getByLabel('Verify saved question evidence brief');
  await input.setInputFiles(jsonFile(saved.text));
  await expect(panel.getByRole('status')).toContainText('Exact evidence brief reproduced');
  value.sources[0].citations[0].text='altered';
  await input.setInputFiles(jsonFile(JSON.stringify(value,null,2)+'\n'));
  await expect(panel.getByRole('alert')).toContainText('Evidence brief rejected');
  await expect(root.getByLabel('View collection question')).toHaveValue('0');
  expect(api).toEqual([]);
});

test('source inspector history excludes identical text in the other PDF and drafts without submitting',async({page})=>{
  const root=await workspace(page,[
    pdf('a.pdf',[['Application fee: INR 500']]),
    pdf('b.pdf',[['Application fee: INR 500','Private additional line']]),
  ]);
  await ask(root,'Application fee?');
  await root.getByLabel('Search document 1',{exact:true}).uncheck();
  await ask(root,'Application fee on page 1?');
  await root.getByLabel('View collection question').selectOption('0');
  const side=root.getByRole('region',{name:'Collection result: Document 1: a.pdf'});
  await side.getByRole('button',{name:'Inspect collection source [1]'}).click();
  const inspection=root.getByRole('region',{name:'Collection source inspection'});
  const history=await expand(inspection,'Citation history for inspected source');
  await expect(history).toContainText('1 citation use(s) in 1 saved turn(s)');
  await expect(history.getByRole('button',{name:'Open citing question 2, part 1'})).toHaveCount(0);
  await root.getByLabel('Collection question',{exact:true}).fill('Unsaved draft');
  const button=history.getByRole('button',{name:'Draft citing question 1, part 1'});
  await expect(button).toBeDisabled();
  await root.getByLabel('Collection question',{exact:true}).fill('');
  await button.click();
  await expect(root.getByLabel('Collection question',{exact:true})).toHaveValue('Application fee?');
  await expect(root.getByLabel('Search document 1',{exact:true})).toBeChecked();
  await expect(root.getByLabel('Search document 2',{exact:true})).not.toBeChecked();
  await expect(root.getByLabel('View collection question').locator('option')).toHaveCount(2);
});

test('reference diagnostics replay saved scope rather than current PDF selection',async({page})=>{
  const root=await workspace(page,[
    pdf('a.pdf',[['Clause 4.2(a) Eligibility','See Section 9.']]),
    pdf('b.pdf',[['Clause 4.2(a) Fees']]),
  ]);
  let index=await expand(root,'Collection reference index');
  let exchange=await expand(index,'reference index report exchange');
  const exportButton=exchange.getByRole('button',{name:'Export reference index report'});
  await expect(exportButton).toBeDisabled();
  await exchange.getByLabel('I approve exporting this private reference index report.').check();
  const saved=await downloadJson(page,exportButton),raw=JSON.parse(saved.text);
  expect(raw.source_ids).toHaveLength(2);
  expect(raw.groups.find((row:any)=>row.identifier==='4.2(a)').state).toBe('multiple_leading');
  expect(saved.text).not.toContain('Eligibility');
  await root.getByLabel('Search document 2',{exact:true}).uncheck();
  index=await expand(root,'Collection reference index');
  exchange=await expand(index,'reference index report exchange');
  const input=exchange.getByLabel('Verify saved reference index report');
  await input.setInputFiles(jsonFile(saved.text));
  await expect(exchange.getByRole('status')).toContainText('reproduced for 2 PDF(s)');
  raw.total_occurrences++;
  await input.setInputFiles(jsonFile(JSON.stringify(raw,null,2)+'\n'));
  await expect(exchange.getByRole('alert')).toContainText('Report rejected');
  await expect(root.getByLabel('Search document 2',{exact:true})).not.toBeChecked();
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
});

test('native quality report exchange remains diagnostic and rejects modified counts',async({page})=>{
  const root=await workspace(page,[pdf('quality.pdf',[['Repeated line'],['Repeated line'],[]])]);
  const quality=await expand(root,'Native extraction quality signals');
  await expect(quality).toContainText('Exact text repeated on different pages');
  const exchange=await expand(quality,'native quality report exchange');
  await exchange.getByLabel('I approve exporting this private native quality report.').check();
  const saved=await downloadJson(page,exchange.getByRole('button',{name:'Export native quality report'}));
  const raw=JSON.parse(saved.text);
  expect(raw.counts.repeated_across_pages).toBe(2);
  expect(raw.sources[0].pages[2].coverage).toBe('no_indexed_text');
  expect(saved.text).not.toContain('Repeated line');
  const input=exchange.getByLabel('Verify saved native quality report');
  await input.setInputFiles(jsonFile(saved.text));
  await expect(exchange.getByRole('status')).toContainText('Exact native quality report reproduced');
  raw.counts.repeated_across_pages=99;
  await input.setInputFiles(jsonFile(JSON.stringify(raw,null,2)+'\n'));
  await expect(exchange.getByRole('alert')).toContainText('Report rejected');
  await expect(root.getByLabel('Collection conversation')).toHaveCount(0);
});
