import { isAbsolute, resolve } from 'path';
import { createWriteStream } from 'fs';
import { get } from 'http';

import { Command, flags } from '@oclif/command';
import * as plantumlEncoder from 'plantuml-encoder';
import { createConnection, EntityMetadata, Connection, ConnectionOptionsReader } from 'typeorm';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import { ForeignKeyMetadata } from 'typeorm/metadata/ForeignKeyMetadata';

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
			description: 'Outputs plantuml syntax instead of the url',
			default: false
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

	/**
	 * Executes this command.
	 *
	 * @async
	 * @public
	 */
	public async run(): Promise<any> {
		try {
			const { args, flags } = this.parse( TypeormUmlCommand );
			if (flags.uml) {
				const uml = await this.getUml(args.configName, flags);
				process.stdout.write(`${uml}\n`);
			} else {
				const url = await this.getUrl(args.configName, flags);
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

	private async getUml(configName: string, flags: TypeormUmlCommandFlags) {
		const connectionOptionsReader = new ConnectionOptionsReader( {
			root: process.cwd(),
			configName,
		} );

		const connectionOptions = await connectionOptionsReader.get( flags.connection );
		const connection = await createConnection( connectionOptions );

		const uml = this.buildUml( connection, flags );

		connection.close();

		return uml;
	}

	/**
	 * Builds a plantuml URL and returns it.
	 *
	 * @async
	 * @private
	 * @param {string} configName A path to Typeorm config file.
	 * @param {TypeormUmlCommandFlags} flags An object with command flags.
	 * @returns {string} A plantuml string.
	 */
	private async getUrl( configName: string, flags: TypeormUmlCommandFlags ): Promise<string> {
		const uml = await this.getUml(configName, flags);
		const encodedUml = plantumlEncoder.encode( uml );

		const format = encodeURIComponent( flags.format );
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
	 * @param {TypeormUmlCommandFlags} flags An object with command flags.
	 * @returns {string} An uml string.
	 */
	private buildUml( connection: Connection, flags: TypeormUmlCommandFlags ): string {
		let uml = `@startuml\n\n`;

		uml += `!define table(x) class x << (T,#FFAAAA) >>\n`;
		uml += `!define pkey(x) <b>x</b>\n`;
		uml += `hide stereotypes\n`;
		uml += `hide methods\n\n`;
		uml += `hide circle\n\n`;

		if ( flags.monochrome ) {
			uml += `skinparam monochrome true\n\n`;
		}

		const exclude = ( flags.exclude || '' ).split( ',' ).filter( ( item ) => item.trim().length );
		const include = ( flags.include || '' ).split( ',' ).filter( ( item ) => item.trim().length );

		let foreignUmls = "";

		for ( let i = 0, len = connection.entityMetadatas.length; i < len; i++ ) {
			const entity = connection.entityMetadatas[i];

			if ( exclude.includes( entity.name ) ) {
				continue;
			}

			if ( include.length && ! include.includes( entity.name ) ) {
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

	/**
	 * Builds an uml class for an entity and returns it.
	 *
	 * @private
	 * @param {EntityMetadata} entity An entity metadata.
	 * @param {Connection} connection A database connection.
	 * @returns {string} An uml class string.
	 */
	private buildClass( entity: EntityMetadata, connection: Connection ): [string,string] {
		let uml = `\nentity "<b>${entity.name}</b>\\n<font size="10" color="gray">${ entity.tableNameWithoutPrefix }</font>" as ${this.getEntityKey(entity)} {\n`;

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
		const columnInfo = `<b>${column.propertyName}</b>    <font color="#a9a9a9">${column.databaseName}</font><font color="gray">: ${columnType}</font>`;
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
		const referencedEntity = this.getEntityKey(foreignKey.referencedEntityMetadata);
		if (foreignKey.columns.length === 1) {
			const column = foreignKey.columns[0];
			return `${this.getEntityKey(entity)}::${column.propertyName} --> ${referencedEntity}\n\n`;
		} else {
			return `${this.getEntityKey(entity)} --> ${referencedEntity}\n\n`;
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
