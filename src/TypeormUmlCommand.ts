import { isAbsolute, resolve } from 'path';
import { createWriteStream } from 'fs';
import { get } from 'http';

import { Command, flags } from '@oclif/command';
import * as plantumlEncoder from 'plantuml-encoder';
import { createConnection, EntityMetadata, Connection, ConnectionOptionsReader } from 'typeorm';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import { ForeignKeyMetadata } from 'typeorm/metadata/ForeignKeyMetadata';
import { OutputFlags } from '@oclif/parser';

interface ColumnDataTypeDefaults {
	length?: string,
	width?: number,
	precision?: number,
	scale?: number,
}

interface TypeormUmlCommandFlags {
	format?: string,
	monochrome?: boolean,
	connection?: string,
	include?: string,
	exclude?: string,
}

const parseFlagsArray = (items: string) =>
	( items || '' )
		.split( ',' )
		.map(item => item.trim())
		.filter( ( item ) => item.length )
		.map(item => {
			const matches = item.match(/^\/(.+)\/$/);
			if (matches) {
				return new RegExp(matches[1]);
			}
			return item;
		});

const isInArray = (target: string, items: Array<string|RegExp>) => {
	for (const item of items) {
		if (typeof item === 'string') {
			if (item === target) {
				return true;
			}
		} else if (item instanceof RegExp) {
			if (target.match(item)) {
				return true;
			}
		}
	}
	return false;
};

enum NamesEnum {
	Entities = 'entities',
	Tables = 'tables'
}

class TypeormUmlCommand extends Command {

	static description = 'Generates a database UML diagram based on Typeorm entities.';

	static args = [
		{
			name: 'configName',
			required: false,
			description: 'Path to the Typeorm config file.',
			default: 'ormconfig.json',
		},
	];

	static flags = {
		connection: flags.string( {
			char: 'c',
			description: 'The connection name.',
			default: 'default',
		} ),
		format: flags.string( {
			char: 'f',
			description: 'The diagram file format.',
			default: 'png',
			options: ['png', 'svg', 'txt'],
		} ),
		monochrome: flags.boolean( {
			description: 'Whether or not to use monochrome colors.',
			default: false,
		} ),
		download: flags.string( {
			char: 'd',
			description: 'The filename where to download the diagram.',
		} ),
		uml: flags.boolean( {
			char: 'u',
			description: 'Outputs plantuml syntax instead of the url.',
			default: false
		} ),
		names: flags.string( {
			char: 'n',
			multiple: true,
			options: [NamesEnum.Entities, NamesEnum.Tables],
			description: 'Specify which names to output: typeorm names, database names or both.',
			default: [NamesEnum.Tables]
		} ),
		exclude: flags.string( {
			char: 'e',
			description: 'Comma-separated list of entities to exclude from the diagram.',
		} ),
		include: flags.string( {
			char: 'i',
			description: 'Comma-separated list of entities to include into the diagram.',
		} ),
	};

	flags: OutputFlags<typeof TypeormUmlCommand.flags>;
	include?: Array<string|RegExp>;
	exclude?: Array<string|RegExp>;
	outEntities: boolean = false;
	outTables: boolean = false;

	/**
	 * Executes this command.
	 *
	 * @async
	 * @public
	 */
	public async run(): Promise<any> {
		try {
			const { args, flags } = this.parse( TypeormUmlCommand );
			this.flags = flags;
			this.exclude = parseFlagsArray( this.flags.exclude );
			this.include = parseFlagsArray( this.flags.include );
			this.outEntities = this.flags.names.includes(NamesEnum.Entities);
			this.outTables = this.flags.names.includes(NamesEnum.Tables);

			if (flags.uml) {
				const uml = await this.getUml(args.configName);
				process.stdout.write(`${uml}\n`);
			} else {
				const url = await this.getUrl(args.configName);
				if (flags.download) {
					await this.download(url, flags.download);
				} else {
					process.stdout.write(`${url}\n`);
				}
			}
		} catch ( e ) {
			this.error( e.message );
		}
	}

	private async getUml(configName: string) {
		const connectionOptionsReader = new ConnectionOptionsReader( {
			root: process.cwd(),
			configName,
		} );

		const connectionOptions = await connectionOptionsReader.get( this.flags.connection );
		const connection = await createConnection( connectionOptions );

		const uml = this.buildUml( connection );

		connection.close();

		return uml;
	}

	/**
	 * Builds a plantuml URL and returns it.
	 *
	 * @async
	 * @private
	 * @param {string} configName A path to Typeorm config file.
	 * @returns {string} A plantuml string.
	 */
	private async getUrl( configName: string ): Promise<string> {
		const uml = await this.getUml(configName);
		const encodedUml = plantumlEncoder.encode( uml );

		const format = encodeURIComponent( this.flags.format );
		const schema = encodeURIComponent( encodedUml );

		return `http://www.plantuml.com/plantuml/${ format }/${ schema }`;
	}

	/**
	 * Downloads image into a file.
	 *
	 * @private
	 * @param {string} url The URL to download.
	 * @param {string} filename The output filename.
	 * @returns {Promise} A promise object.
	 */
	private download( url: string, filename: string ): Promise<void> {
		const path = ! isAbsolute( filename ) ? resolve( process.cwd(), filename ) : filename;

		return new Promise( ( resolve ) => {
			get( url, ( response ) => {
				response.pipe( createWriteStream( path ) );
				response.on( 'end', resolve );
			} );
		} );
	}

	/**
	 * Builds database uml and returns it.
	 *
	 * @private
	 * @param {Connection} connection A database connection.
	 * @returns {string} An uml string.
	 */
	private buildUml( connection: Connection ): string {
		let uml = `@startuml\n\n`;

		if (this.outEntities && this.outTables) {
			uml += `!define table(ename, tname) entity "<b>ename</b>\\n<font size="10" color="gray">tname</font>" as ename\n`;
			uml += `!define column(pname, tname, type) pname    <font color="#a9a9a9">tname</font><font color="gray">: type</font>\n`;
		} else if (this.outEntities) {
			uml += `!define table(ename, tname) entity ename\n`;
			uml += `!define column(pname, tname, type) pname<font color="gray">: type</font>\n`;
		} else if (this.outTables) {
			uml += `!define table(ename, tname) entity "tname" as ename\n`;
			uml += `!define column(pname, tname, type) tname<font color="gray">: type</font>\n`;
		} else {
			throw new Error('Please specify what names to output using --names argument');
		}

		uml += `hide stereotypes\n`;
		uml += `hide methods\n`;
		uml += `hide circle\n\n`;

		if ( this.flags.monochrome ) {
			uml += `skinparam monochrome true\n\n`;
		}

		let foreignUmls = "";

		for ( let i = 0, len = connection.entityMetadatas.length; i < len; i++ ) {
			const entity = connection.entityMetadatas[i];

			if (!this.isEntityIncluded(entity)) {
				continue;
			}

			const [classUml, foreignUml] = this.buildClass( entity, connection );
			uml += classUml;
			foreignUmls += foreignUml;
		}

		uml += foreignUmls;

		uml += `@enduml\n`;

		return uml;
	}

	private getEntityKey(entity: EntityMetadata) {
		return entity.name;
	}

	private getColumnKey(column: ColumnMetadata) {
		if (this.outEntities) {
			return column.propertyName;
		} else {
			return column.databaseName;
		}
	}

	private isEntityIncluded(entity: EntityMetadata) {
		if ( isInArray(entity.name, this.exclude) ) {
			return false;
		}

		if ( this.include.length > 0 && !isInArray(entity.name, this.include)) {
			return false;
		}

		return true;
	}

	/**
	 * Builds an uml class for an entity and returns it.
	 *
	 * @private
	 * @param {EntityMetadata} entity An entity metadata.
	 * @param {Connection} connection A database connection.
	 * @returns {string} An uml class string.
	 */
	private buildClass( entity: EntityMetadata, connection: Connection ): [string,string] {
		let uml = `\ntable(${this.getEntityKey(entity)}, ${entity.tableNameWithoutPrefix}) {\n`;

		for ( let i = 0, len = entity.columns.length; i < len; i++ ) {
			uml += this.buildColumn( entity.columns[i], entity, connection );
		}

		uml += `}\n\n`;

		let foreignKeysUml = "";
		for ( let i = 0, len = entity.foreignKeys.length; i < len; i++ ) {
			foreignKeysUml += this.buildForeignKeys( entity.foreignKeys[i], entity );
		}

		return [uml, foreignKeysUml];
	}

	/**
	 * Builds an uml column and returns it.
	 *
	 * @private
	 * @param {ColumnMetadata} column A column metadata.
	 * @param {EntityMetadata} entity An entity metadata.
	 * @param {Connection} connection A database connection.
	 * @returns {string} An uml column string.
	 */
	private buildColumn( column: ColumnMetadata, entity: EntityMetadata, connection: Connection ): string {
		let prefix = '';

		if ( column.isPrimary ) {
			prefix = '+';
		} else if ( Array.isArray( entity.indices ) && entity.indices.length > 0 ) {
			const index = entity.indices.find( ( idx ) => idx.columns.map( column => column.databaseName ).includes( column.databaseName ) );
			if ( index ) {
				prefix = index.isUnique ? '~' : '#';
			}
		}

		let length = this.getColumnLength( column );
		const type = connection.driver.normalizeType( column );

		if ( ! length && connection.driver.dataTypeDefaults[type] ) {
			length = this.getColumnLength( ( connection.driver.dataTypeDefaults[type] as unknown ) as ColumnDataTypeDefaults );
		}

		if ( length ) {
			length = `(${ length })`;
		}

		const columnType = `${ type.toUpperCase() }${ length }`;
		const columnInfo = `column(${column.propertyName}, ${column.databaseName}, ${columnType})`;
		return `\t${ prefix }${ columnInfo }\n`;
	}

	/**
	 * Builds am uml connection string and returns it.
	 *
	 * @private
	 * @param {ForeignKeyMetadata} foreignKey A foreign key metadata.
	 * @param {EntityMetadata} entity An entity metadata.
	 * @returns {string} An uml connection string.
	 */
	private buildForeignKeys( foreignKey: ForeignKeyMetadata, entity: EntityMetadata ): string {
		if (!this.isEntityIncluded(foreignKey.referencedEntityMetadata)) {
			return '';
		}
		const referencedEntityKey = this.getEntityKey(foreignKey.referencedEntityMetadata);
		if (foreignKey.columns.length === 1) {
			const column = foreignKey.columns[0];
			return `${this.getEntityKey(entity)}::${this.getColumnKey(column)} --> ${referencedEntityKey}\n\n`;
		} else {
			return `${this.getEntityKey(entity)} --> ${referencedEntityKey}\n\n`;
		}
	}

	/**
	 * Returns a column size or default size if not provided.
	 *
	 * @private
	 * @param {ColumnMetadata | ColumnDataTypeDefaults} column The column instance or data type defaults.
	 * @returns {string} The column size on success, otherwise empty string.
	 */
	private getColumnLength( column: ColumnMetadata | ColumnDataTypeDefaults ): string {
		if ( column.length ) {
			return column.length;
		}

		if ( column.width ) {
			return column.width.toString();
		}

		if ( column.precision ) {
			if ( column.scale ) {
				return `${ column.precision }, ${ column.scale }`;
			}

			return column.precision.toString();
		}

		return '';
	}

}

export = TypeormUmlCommand;
